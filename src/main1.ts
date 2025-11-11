//version 2024/08/22
import dotenv from "dotenv";
import { cleanEnv, str } from "envalid";

dotenv.config(); // get process.env first. See https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
cleanEnv(process.env, {
  NODE_CONFIG_ENV: str({
    choices: ["development_xnex", "ruifang_testing_area", "px_ruifang"],
    default: "px_ruifang",
  }),
  MODE: str({
    choices: ["debug", "product"],
    default: "product",
  }),
});

import {
  distinctUntilChanged,
  EMPTY,
  filter,
  interval,
  map,
  mapTo,
  merge,
  switchMap,
  switchMapTo,
  take,
  tap,
  Subscription,
  BehaviorSubject,
  throttleTime,
} from "rxjs";
import chalk from "chalk";
import logger from "./logger";
import * as ROS from "./ros";
import * as SOCKET from "./socket";
import config from "./configs";
import { isDifferentPose, SimplePose, TrafficGoal } from "./helpers/geometry";
import { formatPose } from "./helpers";
import {
  Mission_Payload,
  Pause_Payload,
  isLocationIdAndIsAllow,
} from "./types/fleetInfo";
import {
  SysLoggerNormal,
  SysLoggerNormalError,
  SysLoggerNormalWarning,
} from "./logger/systemLogger";
import { count, group } from "console";
import {
  TCLoggerNormal,
  TCLoggerNormalError,
} from "./logger/trafficCenterLogger";
//import fleetMoveMock from './mock ';

function bootstrap() {
  //for log show
  let ros_bridge_error_log = true;
  let ros_bridge_close_log = true;
  let socket_error_log = true;

  let lastPose: SimplePose = { x: 0, y: 0, yaw: 0 };
  let targetLoc: string;
  let missionType: string = "";

  let lastSendGoalId: string = "";
  let accMoveAction: string = "";
  let lastShortestPath: string[];
  let getLeaveLoc$: Subscription;
  let getArriveLoc$: Subscription;
  let reconnectCount$: BehaviorSubject<number> = new BehaviorSubject(0);

  SOCKET.init(config.MAC);
  ROS.init();

  ROS.connected$.subscribe(() => {
    SysLoggerNormal.info(`Connected to ROS Bridge ${config.ROS_BRIDGE_URL}`, {
      type: "ros bridge",
    });
    ros_bridge_error_log = true;
    ros_bridge_close_log = true;
    SOCKET.sendRosBridgeConnection(true);
    reconnectCount$.next(reconnectCount$.value + 1);
  });

  ROS.connectionError$.subscribe((error: Error) => {
    if (ros_bridge_error_log) {
      SysLoggerNormalWarning.warn("ROS Bridge connect error", {
        type: "ros bridge",
        status: error.message,
      });
      ros_bridge_error_log = false;
    }
    SOCKET.sendRosBridgeConnection(false);
    lastSendGoalId = "";
  });

  ROS.connectionClosed$.subscribe(() => {
    if (ros_bridge_close_log) {
      SysLoggerNormalWarning.warn("ROS Bridge connection closed", {
        type: "ros bridge",
      });
      ros_bridge_close_log = false;
    }
    SOCKET.sendRosBridgeConnection(false);
    lastSendGoalId = "";
  });
  
  reconnectCount$.pipe(filter((v) => v > 1)).subscribe((count) => {
    SysLoggerNormal.info(`ros bridge has been reconnected for ${count} time`, {
      type: "ros bridge",
    });
    setTimeout(() => {
      SOCKET.sendRetryConnect(count);
    }, 1000);
  });

  SOCKET.connect$.subscribe(() => {
    SysLoggerNormal.info(
      `Socket connect to Fleet successful ${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}`,
      { type: "socket" }
    );
    socket_error_log = true;
  });

  SOCKET.connectionError$.subscribe((err) => {
    if (socket_error_log) {
      SysLoggerNormalWarning.warn("Socket connect error", {
        type: "socket",
      });
      socket_error_log = false;
    }
  });

  SOCKET.disconnect$.subscribe(() => {
    SysLoggerNormalWarning.warn("Socket Connection closed", {
      type: "socket",
    });
    ROS.cancelCarStatusAnyway(lastSendGoalId);
  });

  merge(
    ROS.connected$.pipe(mapTo(true)),
    ROS.connectionClosed$.pipe(mapTo(false))
  )
    .pipe(
      distinctUntilChanged(),
      switchMap((isConnected) => (isConnected ? EMPTY : interval(5000)))
    )
    .subscribe(() => {
      ROS.reconnect();
    });

  ROS.connected$
    .pipe(switchMapTo(ROS.pose$), take(1))
    .subscribe(({ x, y, yaw }) => {
      if (Math.abs(x) < 0.1 && Math.abs(y) < 0.1 && Math.abs(yaw)) {
        const pose = `(${x.toFixed(2)}, ${y.toFixed(2)}, ${yaw.toFixed(2)})`;
        SysLoggerNormalError.error(
          `Connected to ROS and get pose ${pose}, which is too close to (0, 0) and possible wrong. Please make sure AMR have reasonable initial pose.`,
          {
            type: "ros bridge",
          }
        );
      }
    });

  ROS.pose$.subscribe((pose) => {
    if (isDifferentPose(pose, lastPose, 0.01, 0.01)) {
      logger.silly(`emit socket 'pose' ${formatPose(pose)}`);
    }
    const machineOffset = {
      x: -Math.sin((pose.yaw * Math.PI) / 180) * 0,
      y: -Math.cos((pose.yaw * Math.PI) / 180) * 0,
    };
    SOCKET.sendPose(
      pose.x + machineOffset.x,
      pose.y + machineOffset.y,
      pose.yaw
    );
    lastPose = pose;
  });

  ROS.getReadStatus$.subscribe((data) => {
    const newState = {
      read: {
        feedback_id: data.status.goal_id.id, // 我們的uid
        action_status: data.status.status,
        result_status: data.result.result_status,
        result_message: data.result.result_message,
      },
    };
    const copyMsg = {
      ...newState.read,
      result_message: JSON.parse(newState.read.result_message),
    };

    TCLoggerNormal.info(`mission [${accMoveAction}] complete`, {
      group: "mission",
      type: "mission complete",
      status:
        accMoveAction === "move"
          ? { mid: lastSendGoalId, dest: targetLoc, mission: copyMsg }
          : { mid: lastSendGoalId, mission: copyMsg },
    });

    if (accMoveAction === "move") {
      SOCKET.sendReachGoal(targetLoc);
      missionType = "";
      targetLoc = "";
      setTimeout(() => {
        SOCKET.sendReadStatus(JSON.stringify(newState));
      }, 1000);
      return;
    }
    interval(500)
      .pipe(take(2))
      .subscribe(() => {
        SOCKET.sendReadStatus(JSON.stringify(newState));
      });
  });

  /** 任務開始訊號 Action */
  SOCKET.writeStatus$
    .pipe(
      map(({ status, locationId, actionType, ack }) => {
        return {
          status: JSON.parse(status) as Mission_Payload,
          locationId,
          actionType,
          ack,
        };
      })
    )
    .subscribe((msg) => {
      msg.ack({ code: "0000" });
      accMoveAction = msg.status.Body.operation.type;
      lastSendGoalId = msg.status.Id;

      if (msg.status.Body.operation.type === "move") {
        targetLoc = msg.status.Body.operation.locationId.toString();
        missionType = msg.status.Body.operation.type;
      }

      ROS.writeStatus(msg.status);
      TCLoggerNormal.info(`receive mission ${accMoveAction}`, {
        group: "mission",
        type: "new mission",
        status:
          accMoveAction === "move"
            ? { mid: lastSendGoalId, dest: targetLoc }
            : { mid: lastSendGoalId },
      });
    });

  /** 任務中回傳值 Action Feedback
   * Feedback Content:
      Message {
        header: {
          seq: 3,
          stamp: { secs: 1708049462, nsecs: 974755287 },
          frame_id: ''
        },
        status: { goal_id: { stamp: [Object], id: '12345' }, status: 1, text: '' },
        feedback: {
          feedback_json: '{"task_process": 0, "warning": 0, "warning_id": 23, "warning_msg": "\\u6b63\\u5e38", "is_running": null, "cancel_task": false, "task_status": true}'
        }
        }
   */
  ROS.getFeedbackFromMoveAction$.subscribe((Feedback) => {
    const { status, feedback } = Feedback;
    const actionId = status.goal_id.id;
    if (lastSendGoalId !== actionId) {
      TCLoggerNormalError.error(
        `execute action ID: ${lastSendGoalId} not equal to feedback action ID: ${actionId}`,
        {
          group: "mission",
          type: "ros handshake",
        }
      );
      return;
    }
    if (!actionId) return;
    SOCKET.sendWriteStateFeedback(feedback.feedback_json);
  });

  SOCKET.writeCancel$.subscribe(({ id, ack }) => {
    ack({ code: "0000" });
    if (missionType === "move") {
      if (getLeaveLoc$ && !getArriveLoc$.closed) {
        getLeaveLoc$.unsubscribe();
      }
      if (getArriveLoc$ && !getArriveLoc$.closed) {
        getArriveLoc$.unsubscribe();
      }
    }
    ROS.cancelCarStatusAnyway(lastSendGoalId);
  });

  /** 註冊時會訂閱的一次性 Subscription
   *  用於等待車輛回應以抵達註冊點
   */
  SOCKET.startOneTermAllowPath$
    .pipe(
      tap(() => {
        TCLoggerNormal.info("start register", {
          group: "traffic",
          type: "register",
        });
      }),
      switchMap(() => {
        return ROS.getArriveTarget$.pipe(take(1));
      })
    )
    .subscribe({
      next: (isArriveRes) => {
        TCLoggerNormal.info(
          `register success: Arrive location ${isArriveRes.data}`,
          {
            group: "traffic",
            type: "register",
          }
        );
        const resData = (isArriveRes as { data: string }).data;

        const parseData = JSON.parse(resData);
        SOCKET.sendIsArriveLocation(parseData);
        SOCKET.sendReachGoal(parseData.locationId);
      },
    });

  /** 接收最短路徑 Subscription */
  SOCKET.shortestPath$
    .pipe(
      tap((shortestPath) => {
        lastShortestPath = shortestPath.shortestPath;
      }),
      ROS.shortestPath()
    )
    .subscribe();

  /** 接收重新導航路徑 Subscription */
  SOCKET.reroutePath$
    .pipe(
      tap((reroutePath) => {
        lastShortestPath = reroutePath.reroutePath;
      }),
      ROS.reroutePath()
    )
    .subscribe();

  /** 通行權 (isAllow: true/false) Subscription */
  SOCKET.allowPath$
    .pipe(filter(isLocationIdAndIsAllow))
    .subscribe((allowTarget) => {
      if (allowTarget.isAllow) {
        TCLoggerNormal.info(`send  allow location ${allowTarget.locationId}`, {
          group: "traffic",
          type: "isAllow",
        });
        getArriveLoc$ = ROS.getArriveTarget$
          .pipe(take(1))
          .subscribe((isArriveRes) => {
            TCLoggerNormal.info(`receive arrive location ${isArriveRes.data}`, {
              group: "traffic",
              type: "isArrive",
            });
            const resData = (isArriveRes as { data: string }).data;
            SOCKET.sendIsArriveLocation(JSON.parse(resData));
            const parseData = JSON.parse(resData);
            if (targetLoc === allowTarget.locationId) {
              SOCKET.sendReachGoal(parseData.locationId);
            }
          });
        if (targetLoc !== allowTarget.locationId) {
          TCLoggerNormal.info("create leave location obs", {
            group: "traffic",
            type: "create leave obs",
            status: { waitLeave: allowTarget.locationId },
          });
          getLeaveLoc$ = ROS.getLeaveLocation$
            .pipe(
              filter((response) => {
                const Loc = JSON.parse(response.data).locationId;
                return Loc === allowTarget.locationId;
              }),
              take(1)
            )
            .subscribe((leaveLocation) => {
              const leaveLoc = JSON.parse(leaveLocation.data);
              TCLoggerNormal.info(
                `receive leave location ${leaveLoc.locationId}`,
                {
                  group: "traffic",
                  type: "isAway",
                  status: {},
                }
              );
              if (!lastShortestPath.length) return;
              SOCKET.sendIsLeaveLocation(leaveLocation);
            });
        }
      }
      ROS.allowTarget(
        allowTarget as {
          locationId: string;
          isAllow: boolean;
        }
      );
    });

  ROS.getAmrError$.subscribe((msg: { data: string }) => {
    const trans = JSON.parse(msg.data);
    SOCKET.sendCarErrorInfo(trans);
  });

  ROS.getRealTimeReadStatus$.subscribe((data) => {
    SOCKET.sendRealTimeReadStatus(data);
  });

  SOCKET.updatePosition$.subscribe((data) => {
    ROS.updatePosition({ data: data.isUpdate });
  });
  ROS.getIOInfo$.subscribe((data) => {
    SOCKET.sendIOInfo(data);
  });

  ROS.topicTask$.subscribe((msg) => {
    SOCKET.topicTask(msg);
  });

  ROS.currentId$.pipe(throttleTime(5000)).subscribe((currentId) => {
    SOCKET.sendCurrentId(currentId);
  });

  // SOCKET.cancelAnyways$.subscribe(()=>{
  //   ROS.cancelCarStatusAnyway()
  // })

  // 急停
  SOCKET.pause$.subscribe((msg) => {
    msg.ack({ code: "0000" });
    ROS.pause(msg.payload);
  });

  // 復歸
  SOCKET.forceReset$.subscribe((msg) => {
    msg.ack({ code: "0000" });
    ROS.forceResetButton();
  });

  ROS.currentPoseAccurate$.subscribe((msg) => {
    SOCKET.sendCurrentPoseIsAccurate(msg);
  });

  ROS.getHeartbeat$.subscribe((msg) => {
    SOCKET.sendHeartbeat(msg);
  });

  SOCKET.heartbeat$.subscribe((msg) => {
    ROS.heartbeat(msg.payload);
  });

  ROS.getVerityCargo$.subscribe((msg) => {
    SOCKET.sendCargoVerity(msg);
  });

  ROS.cancelCarStatusAnyway(lastSendGoalId);
}

void bootstrap();
