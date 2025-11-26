/* eslint-disable @typescript-eslint/naming-convention */
import ROSLIB, { Ros } from "roslib";
import {
  EMPTY,
  Observable,
  fromEventPattern,
  interval,
  mapTo,
  merge,
  share,
  switchMap
} from "rxjs";
import { boolean, number, object, string } from "yup";

import chalk from "chalk";
import { sampleInterval, tfTransformToCoords } from "~/helpers";
import config from "~/configs";
import { SimplePose } from "~/helpers/geometry";
import {
  MyRosMessage,
  IsArrive,
  FeedbackOfMove,
  isAway,
  Mission_Payload,
} from "~/types/fleetInfo";

import * as SOCKET from "../socket";
import logger from "~/logger";
import { TCLoggerNormal, TCLoggerNormalError, TCLoggerNormalWarning } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { RES_EX } from "~/mq/type/type";
import { sendBaseResponse } from "~/mq/transactionsWrapper";
import { ReturnCode } from "~/mq/type/returnCode";
import { CMD_ID } from "~/mq/type/cmdId";

const ros = new ROSLIB.Ros({ encoding: "utf8" } as any); // cast for removing warning

enum GoalStatus {
  PENDING = 0, // The goal has yet to be processed by the action server
  ACTIVE = 1, // The goal is currently being processed by the action server
  PREEMPTED = 2, // The goal received a cancel request after it started executing and has since completed its execution (Terminal State)
  SUCCEEDED = 3, // The goal was achieved successfully by the action server (Terminal State)
  ABORTED = 4, // The goal was aborted during execution by the action server due to some failure (Terminal State)
  REJECTED = 5, // The goal was rejected by the action server without being processed, because the goal was unattainable or invalid (Terminal State)
  PREEMPTING = 6, // The goal received a cancel request after it started executing and has not yet completed execution
  RECALLING = 7, // The goal received a cancel request before it started executing, but the action server has not yet confirmed that the goal is canceled
  RECALLED = 8, // The goal received a cancel request before it started executing and was successfully cancelled (Terminal State)
  LOST = 9, // An action client can determine that a goal is LOST. This should not be sent over the wire by an action server
}

const terminalStates = [
  GoalStatus.SUCCEEDED,
  GoalStatus.PREEMPTED,
  GoalStatus.RECALLED,
  GoalStatus.ABORTED,
  GoalStatus.REJECTED,
] as const;

export function init() {
  ros.connect(config.ROS_BRIDGE_URL);
}

export function reconnect() {
  ros.connect(config.ROS_BRIDGE_URL);
}

export const connected$ = fromEventPattern<never>((next) => {
  ros.on("connection", next);
}).pipe(share());

export const connectionError$ = fromEventPattern<Error>((next) => {
  ros.on("error", next);
}).pipe(share());

export const connectionClosed$ = fromEventPattern<never>((next) => {
  ros.on("close", next);
}).pipe(share());

// 座標✅
export const pose$ = (() => {
  const schema = object({
    translation: object({
      x: number().required(),
      y: number().required(),
      z: number().required(),
    }),
    rotation: object({
      x: number().required(),
      y: number().required(),
      z: number().required(),
      w: number().required(),
    }).required(),
  });

  return merge(
    connected$.pipe(mapTo(true)),
    connectionError$.pipe(mapTo(false)), // maybe we only need one of connectionError$ or connectionClosed$
    connectionClosed$.pipe(mapTo(false))
  ).pipe(
    switchMap((isRosAlive) => {
      if (!isRosAlive) return EMPTY;

      return fromEventPattern<SimplePose>((next) => {
        new ROSLIB.TFClient({
          ros,
          fixedFrame: "map",
          angularThres: 0.01,
          transThres: 0.01,
        }).subscribe("base_link", (msg) => {
          next(
            tfTransformToCoords(
              schema.validateSync(msg, { stripUnknown: true })
            )
          );
        });
      }).pipe(sampleInterval(100));
    }),
    share()
  );
})();

// ---------------mission send control----------

// 插車回傳io狀況
export const getIOInfo$ = (() => {
  const schema = object({
    data: string().required("amr io info missed"),
  }).required("amr info missed");

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: `/kenmec_${config.AMR}/io_info`,
    messageType: "std_msgs/String",
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();

// ------------------------------------------------------------------------------ 交車主要交握

// 傳送最佳路徑
export const shortestPath = () => {
  return (shortestPath$: Observable<{ shortestPath: string[] }>) => {
    const service = new ROSLIB.Service({
      ros,
      name: "/fleet_manager/shortest_path",
      serviceType: `kenmec_${config.AMR}_socket/shortest_path`,
    });
    return new Observable<{ result: boolean }>((subscriber) => {
      shortestPath$.subscribe((shortest_Path) => {
        TCLoggerNormal.info("send shortest path", {
          group: "traffic",
          type: "shortest path [req]",
          status: shortest_Path.shortestPath
        })
        service.callService(
          {
            shortestPath: shortest_Path.shortestPath,
          },
          (data) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            if (data.result as boolean) {
              SOCKET.sendShortestIsReceived(data.result);
            }

            TCLoggerNormal.info(`receive shortest path response from ros service`, {
              group: "traffic",
              type: "shortest path [res]",
              status: { serviceName: service.name, res: data }
            })
          },
          (error: string) => {
            TCLoggerNormalError.error(`Service request is failed `, {
              group: "traffic",
              type: "shortest path",
              status: error
            })
          }
        );
      });
    });
  };
};

// 重新規劃路徑
export const reroutePath = () => {
  return (reroutePath$: Observable<{ reroutePath: string[] }>) => {
    const service = new ROSLIB.Service({
      ros,
      name: "/fleet_manager/update_path",
      serviceType: `kenmec_${config.AMR}_socket/update_path`,
    });
    return new Observable<{ result: boolean }>((subscriber) => {
      reroutePath$.subscribe((reroute_Path) => {

        TCLoggerNormal.info("send reroute path", {
          group: "traffic",
          type: "reroute path [req]",
          status: reroute_Path.reroutePath
        })

        service.callService(
          {
            updatePath: reroute_Path.reroutePath,
          },
          (response) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            if (response.result as boolean) {
              SOCKET.sendReroutePathInProcess(response);
            }
            TCLoggerNormal.info(`receive reroute path response from ros service`, {
              group: "traffic",
              type: "reroute path [res]",
              status: { serviceName: service.name, res: response }
            })
          },
          (error: string) => {
            TCLoggerNormalError.error(`Service request is failed `, {
              group: "traffic",
              type: "reroute path",
              status: error
            })
          }
        );
      });
    });
  };
};

export const getFeedbackFromMoveAction$ = (() => {
  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: `/kenmec_${config.AMR}/fleet_manager/mission/feedback`,
    messageType: `kenmec_${config.AMR}_socket/MissionActionFeedback`,
  });

  return fromEventPattern<FeedbackOfMove>((next) => {
    topic.subscribe((msg) => {
      next(msg);
    });
  });
})();

export const getLeaveLocation$ = (() => {
  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: `/kenmec_${config.AMR}/navigation/is_away`,
    messageType: "std_msgs/String",
  });

  return fromEventPattern<isAway>((next) => {
    topic.subscribe((msg) => {
      next(msg);
    });
  });
})();

export const getArriveTarget$ = (() => {
  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: `/kenmec_${config.AMR}/navigation/is_arrive`,
    messageType: "std_msgs/String",
  });

  return fromEventPattern<IsArrive>((next) =>
    topic.subscribe((msg) => {
      next(msg);
    })
  );
})();


export const sendShortestPath = (() => {
  const service = new ROSLIB.Service({
    ros,
    name: "/fleet_manager/shortest_path",
    serviceType: `kenmec_${config.AMR}_socket/shortest_path`,
  });

  return (rb: RBClient, data: { shortestPath: string[], id: string, amrId: string }) => {
    const { shortestPath, id, amrId } = data;
    TCLoggerNormal.info("send shortest path", {
      group: "traffic",
      type: "shortest path [req]",
      status: shortestPath
    });
    service.callService(
      {
        shortestPath: shortestPath,
      },
      (data) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (data.result as boolean) {
          rb.resPublish(
            RES_EX,
            `amr.res.${config.MAC}.promise.shortestPath`,
            sendBaseResponse({ amrId, return_code: ReturnCode.SUCCESS, cmd_id: CMD_ID.SHORTEST_PATH, id }),
            { expiration: "10000" }
          )
          TCLoggerNormal.info(`receive shortest path response from ros service`, {
            group: "traffic",
            type: "shortest path [res]",
            status: { serviceName: service.name, res: data }
          });
          return;
        };
      },
      (error: string) => {
        TCLoggerNormalError.error(`Service request is failed `, {
          group: "traffic",
          type: "shortest path",
          status: error
        });
        rb.resPublish(
          RES_EX,
          `amr.res.${config.MAC}.promise.shortestPath`,
          sendBaseResponse({
            amrId, return_code: ReturnCode.shortestPathServiceFailed,
            cmd_id: CMD_ID.SHORTEST_PATH,
            id
          }),
          { expiration: "10000" }
        )
      }
    );
  }
})();

export const sendIsAllowTarget = (() => {
  const service = new ROSLIB.Service({
    ros,
    name: "/fleet_manager/allow_path",
    serviceType: `kenmec_${config.AMR}_socket/TrafficStatus`,
  });
  return (rb: RBClient, nextLocation: { locationId: string, isAllow: boolean, amrId: string, id: string }) => {
    const { locationId, isAllow, amrId, id } = nextLocation;
    service.callService(
      { locationId, isAllow },
      (res) => {
        if ((res as { result: boolean }).result) {
          rb.resPublish(
            RES_EX,
            `amr.res.${config.MAC}.promise.isAllow`,
            sendBaseResponse({ amrId, return_code: ReturnCode.SUCCESS, cmd_id: CMD_ID.ALLOW_PATH, id }),
            { expiration: "10000" }
          )
          return;
        }
        rb.resPublish(
          RES_EX,
          `amr.res.${config.MAC}.promise.isAllow`,
          sendBaseResponse({
            amrId, return_code: ReturnCode.isAllowServiceFailed,
            cmd_id: CMD_ID.ALLOW_PATH,
            id
          }),
          { expiration: "10000" }
        )
      },
      (error: string) => {
        TCLoggerNormalError.error(`Service request is failed `, {
          group: "traffic",
          type: "isAllow",
          status: error
        });
        rb.resPublish(
          RES_EX,
          `amr.res.${config.MAC}.promise.isAllow`,
          sendBaseResponse({
            amrId, return_code: ReturnCode.isAllowServiceFailed,
            cmd_id: CMD_ID.ALLOW_PATH,
            id
          }),
          { expiration: "10000" }
        )
      }
    );
  }
})();


export const allowTarget = (() => {
  const service = new ROSLIB.Service({
    ros,
    name: "/fleet_manager/allow_path",
    serviceType: `kenmec_${config.AMR}_socket/TrafficStatus`,
  });

  return (nextLocation: { locationId: string; isAllow: boolean }) => {
    service.callService(
      nextLocation,
      (res) => {
        if (!(res as { result: boolean }).result) {
          return;
        }
      },
      (error: string) => {
        TCLoggerNormalError.error(`Service request is failed `, {
          group: "traffic",
          type: "isAllow",
          status: error
        })
      }
    );
  };
})();

// 傳送寫入 主要是任務
export const writeStatus = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: `/kenmec_${config.AMR}/fleet_manager/mission/goal`,
    messageType: `kenmec_${config.AMR}_socket/MissionActionGoal`,
  });

  return (msg: Mission_Payload) => {
    topic.publish({
      header: {
        seq: 0,
        stamp: {
          secs: 0,
          nsecs: 0,
        },
        frame_id: "",
      },
      goal_id: {
        stamp: {
          secs: 0,
          nsecs: 0,
        },
        id: msg.Id, // 這邊要自己設計id 跟回傳 跟cancel都是參造這個id
      },
      goal: {
        request_json: JSON.stringify(msg),
      },
    });
  };
})();


// 插車回傳任務狀況
export const getReadStatus$ = (() => {
  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: `/kenmec_${config.AMR}/fleet_manager/mission/result`,
    messageType: `kenmec_${config.AMR}_socket/MissionActionResult`,
  });

  return fromEventPattern<MyRosMessage>((next) =>
    topic.subscribe((msg) => {
      next(msg);
    })
  );
})();


// ------------------------------------------------------------------------------ 交車主要交握

// 插車回傳任務狀況
export const getRealTimeReadStatus$ = (() => {
  const schema = object({
    data: string().required("amr read status missed "),
  }).required("amr detail data missed");

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: "/fleet_manager/real_time_read_status",
    messageType: "std_msgs/String",
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();

export const getAmrError$ = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: `/kenmec_${config.AMR}/error_info`,
    messageType: "std_msgs/String",
  });
  return fromEventPattern((next) => {
    topic.subscribe((msg: { warning_msg: string[]; warning_id: string[] }) => {
      next(msg);
    });
  });
})();

// 小車氣體
export const updatePosition = (() => {
  // Create a topic instance
  const topic = new ROSLIB.Topic({
    ros,
    name: "/mission_control/update_position",
    messageType: "std_msgs/Bool",
  });

  return (msg: ROSLIB.Message) => {
    // Publish the cancel message
    topic.publish(msg);
  };
})();

// 任何情況都可以使小車取消任務
// 消小車在充電的時候沒衝到電不會賦歸
export const cancelCarStatusAnyway = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: `/kenmec_${config.AMR}/fleet_manager/mission/cancel`,
    messageType: "actionlib_msgs/GoalID",
  });

  return (lastSendGoalId: string) => {
    TCLoggerNormal.info("cancel mission", {
      group: "mission",
      type: "cancel mission",
      status: { mid: lastSendGoalId }
    })
    topic.publish({
      stamp: {
        secs: 0,
        nsecs: 0,
      },
      id: "",
    });
  };
})();

export const topicTask$ = (() => {
  const schema = object({
    data: string().required(),
  }).required();

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: `/kenmec_${config.AMR}/joystick_status`,
    messageType: "std_msgs/String",
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();

export const currentId$ = (() => {
  const schema = object({
    data: string().required("currentId missed"),
  }).required("amr info missed");

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: "/kenmec_fork/current_id",
    messageType: "std_msgs/Int32",
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();

// 傳送寫入 主要是任務
export const pause = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: `/kenmec_${config.AMR}/fleet_manager/pause`,
    messageType: "std_msgs/String",
  });

  return (msg) => {
    // Publish the cancel message
    topic.publish({ data: msg });
  };
})();

export const currentPoseAccurate$ = (() => {
  const schema = object({
    data: boolean().required("currentId missed"),
  }).required("amr info missed");

  const topic = new ROSLIB.Topic<typeof boolean>({
    ros,
    name: "/kenmec_fork/localization_check",
    messageType: "std_msgs/Bool",
  });

  return fromEventPattern<boolean>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();

export const is_registered = (() => {
  const schema = object({
    data: boolean().required("register missed"),
  }).required("amr info missed");

  const topic = new ROSLIB.Topic<typeof boolean>({
    ros,
    name: "/kenmec_fork/is_register",
    messageType: "std_msgs/Bool",
  });

  return fromEventPattern<boolean>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();

// 接收
export const getHeartbeat$ = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: `/kenmec_${config.AMR}/heartbeat_resp`,
    messageType: "std_msgs/String",
  });
  const schema = object({
    data: string().required("heartbeat missed"),
  }).required("heartbeat info missed");

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();

//發送
export const heartbeat = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: `/kenmec_${config.AMR}/heartbeat`,
    messageType: "std_msgs/String",
  });

  return (msg) => {
    // Publish the cancel message
    topic.publish({ data: msg });
  };
})();

//交管傳送賦歸
export const forceResetButton = (() => {
  // Create a topic instance
  const topic = new ROSLIB.Topic({
    ros,
    name: "/kenmec_fork/set_recovery",
    messageType: "std_msgs/Bool",
  });

  return () => {
    // Publish the cancel message
    topic.publish({ data: true });
  };
})();

export const getVerityCargo$ = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: `/kenmec_fork/cargo_result`,
    messageType: "std_msgs/String",
  });
  const schema = object({
    data: string().required("heartbeat missed"),
  }).required("heartbeat info missed");

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    })
  );
})();
