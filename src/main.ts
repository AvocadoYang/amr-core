/* eslint-disable no-console */
/* eslint-disable import/first */
import dotenv from 'dotenv';
import { cleanEnv, str } from 'envalid';

dotenv.config(); // get process.env first. See https://github.com/motdotla/dotenv#how-do-i-use-dotenv-with-import
cleanEnv(process.env, {
  NODE_CONFIG_ENV: str({
    choices: ['development_xnex', 'ruifang_testing_area', 'px_ruifang'],
    default: 'px_ruifang',
  }),
  MODE: str({
    choices: ['debug', 'product'],
    default: 'product',
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
  Observable,
  tap,
  of,
  Subject,
  takeWhile,
  Subscription,
  from,
} from 'rxjs';
import macaddress, { all } from 'macaddress';
import chalk from 'chalk';
import { object, string, number, boolean } from 'yup';
import logger from './logger';
import * as ROS from './ros';
import * as SOCKET from './socket';
import config from './config';
import { isDifferentPose, SimplePose, TrafficGoal } from './helpers/geometry';
import { formatPose } from './helpers';
import { MyRosMessage, WriteStatus } from './types/fleetInfo';
import initWrite from './helpers/initData';
import fleetMoveMock from './mock ';

async function bootstrap() {
  let lastGoal: number = null;
  const currentGoal: TrafficGoal = null;
  const mac = await macaddress.one(config.IFACE_NAME);
  let lastSendGoalId: string = '';
  let lastLocId: number = 0;
  let lastPose: SimplePose = { x: 0, y: 0, yaw: 0 };
  let targetLoc: string;
  let startMoveSteps$: Observable<{ locationId: string; isAllow: boolean }>;
  let accMoveActionId: string;
  let accMoveAction: string;
  let lastWriteStatus: string = JSON.stringify(initWrite);
  let InitSubscription$: Subscription;
  let lastShortestPath: string[];
  const notifyMoveStart$ = new Subject<boolean>();
  let getSendActionFeedback$: Subscription;
  SOCKET.init(mac);
  ROS.init();

  ROS.connected$.subscribe(() => {
    logger.info(`Connected to ROS Bridge ${config.ROS_BRIDGE_URL}`);
  });
  ROS.connectionError$.subscribe((error: Error) => {
    logger.warn(`ROS Bridge connect error: ${JSON.stringify(error)}`);
  });
  ROS.connectionClosed$.subscribe(() => {
    lastGoal = null;
    logger.info('ROS Bridge Connection closed');
  });

  merge(
    ROS.connected$.pipe(mapTo(true)),
    ROS.connectionClosed$.pipe(mapTo(false)),
  )
    .pipe(
      distinctUntilChanged(),
      switchMap((isConnected) => (isConnected ? EMPTY : interval(5000))),
    )
    .subscribe(() => {
      ROS.reconnect();
    });

  ROS.connected$
    .pipe(switchMapTo(ROS.pose$), take(1))
    .subscribe(({ x, y, yaw }) => {
      if (Math.abs(x) < 0.1 && Math.abs(y) < 0.1 && Math.abs(yaw)) {
        const pose = `(${x.toFixed(2)}, ${y.toFixed(2)}, ${yaw.toFixed(2)})`;
        logger.error(
          `Connected to ROS and get pose ${pose}, which is too close to (0, 0) and possible wrong. Please make sure AMR have reasonable initial pose.`,
        );
      }
    });

  ROS.pose$.subscribe((pose) => {
    if (isDifferentPose(pose, lastPose, 0.01, 0.01)) {
      logger.silly(`emit socket 'pose' ${formatPose(pose)}`);
    }
    const machineOffset = {
      x: -Math.sin((pose.yaw * Math.PI) / 180) * config.OFFSET_X,
      y: -Math.cos((pose.yaw * Math.PI) / 180) * config.OFFSET_X,
    };
    // console.log(pose.x + machineOffset.x, pose.y + machineOffset.y, pose.yaw);
    SOCKET.sendPose(
      pose.x + machineOffset.x,
      pose.y + machineOffset.y,
      pose.yaw,
    );
    lastPose = pose;
  });

  ROS.getReadStatus$.subscribe((data) => {
    const myFeedback = data.result.result_status;
    if (myFeedback !== 1) return;
    if (accMoveAction === 'move') {
      getSendActionFeedback$.unsubscribe();
      SOCKET.sendReachGoal(targetLoc);
    }
    const newState = {
      read: {
        is_arrive: true,
        is_locations: [123],
        checked_locations: [123],
        is_taking_goods: false,
        is_dropping_goods: false,
        is_drop_goods: false,
        is_take_goods: false,
        with_goods: false,
        is_finished_mission: false,
        isReadyCharge: false,
        feedback_id: data.status.goal_id.id,
        feedback_code: myFeedback,
      },
      info: {
        amr_id: 1,
        activated: 1,
        is_running: 1,
        warning_msg: '',
        warning_id: 0,
        warning: 0,
        task_process: 110,
        action_process: `F${lastLocId}`,
        pallet_conflict: '',
        grid_info: '',
        charging: false,
        heartbeat: 0,
        error: '',
      },
    };
    console.log('\n', '==========', '\n');
    console.log(`🐝 ${chalk.magenta('mission complete')} 🐝`);
    console.log('\n', '==========');
    SOCKET.sendReadStatus(JSON.stringify(newState));
  });

  ROS.getIOInfo$.subscribe((data) => {
    // console.log(data);
    SOCKET.sendIOInfo(data);
  });

  function isLocationIdAndIsAllow(obj: {
    locationId: string;
    isAllow: boolean;
  }): obj is { locationId: string; isAllow: boolean } {
    return (
      obj &&
      typeof obj.locationId === 'string' &&
      typeof obj.isAllow === 'boolean'
    );
  }

  const startMoveSteps = () => {
    return merge(
      SOCKET.shortestPath$.pipe(take(1),tap((shortestPath) =>{
        lastShortestPath = shortestPath.shortestPath
      }), ROS.shortestPath()),
      SOCKET.allowPath$,
    ).pipe(filter(isLocationIdAndIsAllow));
  };

  InitSubscription$ = startMoveSteps()
    .pipe(takeWhile((allowTarget) => allowTarget.isAllow === true))
    .subscribe((allowTarget) => {
      ROS.allowTarget(
        allowTarget as {
          locationId: string;
          isAllow: boolean;
        },
      );
    });

  SOCKET.writeStatus$
    .pipe(
      filter((msg) => {
        const initPayload = msg.status;
        const init = JSON.stringify(initWrite);
        return initPayload !== init;
      }),
      map((msg) => {
        lastWriteStatus = msg.status;
        const parse = JSON.parse(lastWriteStatus) as WriteStatus;
        return parse;
      }),
      filter((v) => lastSendGoalId !== v.action.mission_status.feedback_id),
      filter((v) => v.action.operation.type !== 'end'),
      filter((v) => v.action.operation.type !== ''),
      map((v) => {
        lastLocId = Number(v.action.operation.id);
        lastSendGoalId = v.action.mission_status.feedback_id;
        accMoveAction = v.action.operation.type;
        const convertedData = {
          operation: {
            type: v.action.operation.type,
            action_id: v.action.mission_status.feedback_id,
            new_task: false,
          },
          move: {
            control: v.action.operation.control,
            goal_id: v.action.operation.id,
            wait: 0,
            is_define_yaw: v.action.operation.is_define_yaw,
            yaw: v.action.operation.yaw,
            tolerance: v.action.operation.tolerance,
            lookahead: v.action.operation.lookahead,
            from: v.action.operation.from,
            to: v.action.operation.to,
            hasCargoToProcess: v.action.operation.hasCargoToProcess,
            max_forward: v.action.operation.max_forward,
            min_forward: v.action.operation.min_forward,
            max_backward: v.action.operation.max_backward,
            min_backward: v.action.operation.min_backward,
            traffic_light_status: false,
          },
          io: {
            fork: {
              is_define_height: v.action.io.fork.is_define_height,
              height: v.action.io.fork.height,
              move: v.action.io.fork.move,
              shift: v.action.io.fork.shift,
              tilt: v.action.io.fork.tilt,
            },
            camera: {
              config: v.action.io.camera.config,
              modify_dis: v.action.io.camera.modify_dis,
            },
          },
          cargo_limit: {
            load: v.action.cargo_limit.load,
            offload: v.action.cargo_limit.offload,
          },
          mission_status: {
            feedback_id: v.action.mission_status.feedback_id,
            name: v.action.mission_status.name,
            start: v.action.mission_status.start,
            end: v.action.mission_status.end,
          },
        };
        return convertedData;
      }),
    )
    .subscribe((msg) => {
      console.log(chalk.greenBright(`write status ${JSON.stringify(msg)}`));
      if (msg.operation.type === 'move') {
        InitSubscription$.unsubscribe();
        targetLoc = msg.move.goal_id.toString();
        ROS.writeStatus(msg);
        startMoveSteps$ = startMoveSteps();

        getSendActionFeedback$ = notifyMoveStart$
          .pipe(
            switchMap((notify) => {
              if (notify) {
                return startMoveSteps$;
              }
              return of(null);
            }),
          )
          .subscribe((allowTarget) => {
            if (process.env.MODE === 'debug') {
              if (!allowTarget.isAllow) return;
              ROS.allowTargetTest(
                allowTarget as {
                  locationId: string;
                  isAllow: boolean;
                },
              );
            } else {
              ROS.allowTarget(
                allowTarget as {
                  locationId: string;
                  isAllow: boolean;
                },
              );
              ROS.getLeaveLocation$.pipe(take(1)).subscribe((leaveLocation) => {
                if(!lastShortestPath.length) return;
                if(leaveLocation.locationId === lastShortestPath[0]){
                  from([leaveLocation, leaveLocation]).subscribe((leaveLocationId) => {
                    SOCKET.sendIsLeaveLocation(leaveLocationId)
                  })
                } else {
                  SOCKET.sendIsLeaveLocation(leaveLocation);
                }
              })
            }
          });

        if (process.env.MODE === 'debug') {
          notifyMoveStart$.next(true);
        }
      } else {
        ROS.writeStatus(msg);
      }
      // ROS.writeStatus(msg.status);
    });

  ROS.getFeedbackFromMoveAction$.subscribe((Feedback) => {
    const schema = object({
      task_process: string().required(),
      action_process: string().required(),
      error: string().required(),
      heartbeat: number().required(),

      with_goods: boolean().required(),
      warning_msg: string().required(),
      warning_id: number().required(),
      warning: number().required(),
    });
    // Message {
    //   header: {
    //     seq: 3,
    //     stamp: { secs: 1708049462, nsecs: 974755287 },
    //     frame_id: ''
    //   },
    //   status: { goal_id: { stamp: [Object], id: '12345' }, status: 1, text: '' },
    //   feedback: {
    //     feedback_json: '{"task_process": 0, "warning": 0, "warning_id": 23, "warning_msg": "\\u6b63\\u5e38", "is_running": null, "cancel_task": false, "task_status": true}'
    //   }
    //  }
    const { status, feedback } = Feedback;
    const actionId = status.goal_id.id;
    if (!actionId) return;
    if (actionId !== accMoveActionId) {
      notifyMoveStart$.next(true);
      accMoveActionId = actionId;
      SOCKET.sendWriteStateFeedback(feedback.feedback_json);
    } else {
      // console.log(Feedback);
    }
  });


  SOCKET.yellowImgLog$.subscribe(({imgPath})=>{
    ROS.yellowImgLog(imgPath)
  })

  SOCKET.writeCancel$.subscribe(({ id }) => {
    // 要傳送的資料長這樣
    const cancelMessage: ROSLIB.Message = {
      stamp: {
        secs: 0,
        nsecs: 0,
      },
      id,
    };

    ROS.writeCancel(cancelMessage);
  });

  ROS.getRealTimeReadStatus$.subscribe((data) => {
    SOCKET.sendRealTimeReadStatus(data)
  })


  ROS.getGas$.subscribe((data) => {
    SOCKET.sendGas(data)
  })

  ROS.getThermal$.subscribe((data) => {
    SOCKET.sendThermal(data)
  })

  SOCKET.updatePosition$.subscribe((data)=>{
    ROS.updatePosition({data: data.isUpdate})
  })

  SOCKET.yellowImgLog$.subscribe(({imgPath})=>{
    ROS.yellowImgLog(imgPath)
  })
  
  logger.info('AMR Core Started, Waiting for ROS and SocketIO connection...');
  // fleetMoveMock(SOCKET, notifyMoveStart$);
}

void bootstrap();
