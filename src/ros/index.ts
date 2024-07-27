/* eslint-disable @typescript-eslint/naming-convention */
import ROSLIB from 'roslib';
import {
  EMPTY,
  Observable,
  fromEventPattern,
  mapTo,
  merge,
  share,
  switchMap,
  take,
} from 'rxjs';
import { boolean, number, object, string } from 'yup';

import chalk from 'chalk';
import { sampleInterval, tfTransformToCoords } from '~/helpers';
import config from '~/config';
import { SimplePose } from '~/helpers/geometry';
import {
  ConvertedWriteStatus,
  MyRosMessage,
  IsArrive,
  FeedbackOfMove,
  isAway
} from '~/types/fleetInfo';

import * as SOCKET from '../socket';
import logger from '~/logger';

const ros = new ROSLIB.Ros({ encoding: 'utf8' } as any); // cast for removing warning

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
  ros.connect(config.ROS_BRIDGE_URL);''
}

export function reconnect() {
  ros.connect(config.ROS_BRIDGE_URL);
}

export const connected$ = fromEventPattern<never>((next) => {
  ros.on('connection', next);
}).pipe(share());

export const connectionError$ = fromEventPattern<Error>((next) => {
  ros.on('error', next);
}).pipe(share());

export const connectionClosed$ = fromEventPattern<never>((next) => {
  ros.on('close', next);
}).pipe(share());

// 座標
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
    connectionClosed$.pipe(mapTo(false)),
  ).pipe(
    switchMap((isRosAlive) => {
      if (!isRosAlive) return EMPTY;

      return fromEventPattern<SimplePose>((next) => {
        new ROSLIB.TFClient({
          ros,
          fixedFrame: 'map',
          angularThres: 0.01,
          transThres: 0.01,
        }).subscribe('base_link', (msg) => {
          // console.log(msg);
          next(
            tfTransformToCoords(
              schema.validateSync(msg, { stripUnknown: true }),
            ),
          );
        });
      }).pipe(sampleInterval(100));
    }),
    share(),
  );
})();

// ---------------mission send control----------

// 插車回傳io狀況
export const getIOInfo$ = (() => {
  const schema = object({
    data: string().required('amr io info missed'),
  }).required('amr info missed');

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: 'kenmec_fork/io_info',
    messageType: 'std_msgs/String',
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    }),
  );
})();

// ------------------------------------------------------------------------------ 交車主要交握

// 傳送路徑

export const shortestPath = () => {
  return (isAllow$: Observable<{ shortestPath: string[] }>) => {
    const service = new ROSLIB.Service({
      ros,
      name: '/fleet_manager/shortest_path',
      serviceType: 'kenmec_fork_socket/shortest_path',
    });
    return new Observable<{ result: boolean }>((subscriber) => {
      isAllow$.subscribe((shortest_Path) => {
        // subscriber.complete();
        console.log('shortestPath is transmitting ...');
        console.log({ shortestPath: shortest_Path });
        service.callService(
          {
            shortestPath: shortest_Path.shortestPath,
          },
          ({ result }) => {
            logger.info(`Result of shortestPath from ${service.name}`);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            if (result as boolean) {
              console.log(
                chalk.blue(`AMR received shortPath, Service server is working`),
              );
              SOCKET.sendShortestIsReceived(result);
              subscriber.complete();
            }
          },
          (error: string) => {
            console.log(`Service request is failed ${error}`);
          },
        );
      });
    });
  };
};






export const getFeedbackFromMoveAction$ = (() => {
  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: '/fleet_manager/mission/feedback',
    messageType: 'kenmec_fork_socket/MissionActionFeedback',
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
    name: '/fleet_manager/is_away',
    messageType: 'std_msgs/String'
  })

  return fromEventPattern<isAway>((next) =>{
    topic.subscribe((msg) => {
      console.log(msg, '==================')
      next(msg)
    })
  })
})()

export const getArriveTarget$ = (() => {
  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: '/fleet_manager/is_arrive',
    messageType: 'std_msgs/String',
  });

  return fromEventPattern<IsArrive>((next) =>
    topic.subscribe((msg) => {
      next(msg);
    }),
  );
})();

export const allowTargetTest = (nextLocation: {
  locationId: string;
  isAllow: boolean;
}) => {
  setTimeout(() => {
    SOCKET.sendIsArriveLocation({
      locationId: nextLocation.locationId,
      isArrive: true,
    });
  }, 2000);
};

export const allowTarget = (() => {
  const service = new ROSLIB.Service({
    ros,
    name: '/fleet_manager/allow_path',
    serviceType: 'kenmec_fork_socket/TrafficStatus',
  });
  const schema = object({
    locationId: string().required(),
    isArrive: boolean().required(),
  });
  return (nextLocation: { locationId: string; isAllow: boolean }) => {
    if (nextLocation.isAllow) {
      getArriveTarget$.pipe(take(1)).subscribe((isArriveRes) => {
        const resData = (isArriveRes as { data: string }).data;
        SOCKET.sendIsArriveLocation(JSON.parse(resData));

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const parseData = JSON.parse(resData);

        setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          SOCKET.sendReachGoal(parseData.locationId);
        }, 2000);
        // schema
        //   .validate(JSON.parse(resData))
        //   .then((transferData) => {
        //     SOCKET.sendIsArriveLocation(transferData);
        //   })
        //   .catch(() => {
        //     console.log('Form error from ROS response');
        //   });
      });
      service.callService(
        nextLocation,
        (res) => {
          if (!(res as { result: boolean }).result) {
            logger.info(
              `Allow location ${nextLocation.locationId}  is transmitted wrong`,
            );
            return;
          }
          // res = { locationId: string, isArrive: boolean}
          logger.info(
            `Allow location ${nextLocation.locationId}  is transmitted successfully  `,
          );
        },
        (error: string) => {
          console.log(`Service request is failed ${error}`);
        },
      );
    } else {
      service.callService(
        nextLocation,
        (res) => {
          if (!(res as { result: boolean }).result) {
            logger.info(
              `Allow location ${nextLocation.locationId}  is transmitted wrong`,
            );
            return;
          }
          logger.info(
            `Allow location ${nextLocation.locationId}  is transmitted successfully  `,
          );
        },
        (error: string) => {
          console.log(`Service request is failed ${error}`);
        },
      );
    }
  };
})();

// 傳送寫入 主要是任務
export const writeStatus = (() => {
  const topic = new ROSLIB.Topic({
    ros,
    name: '/fleet_manager/mission/goal',
    messageType: 'kenmec_fork_socket/MissionActionGoal',
  });

  return (msg: ConvertedWriteStatus) => {
    topic.publish({
      header: {
        seq: 0,
        stamp: {
          secs: 0,
          nsecs: 0,
        },
        frame_id: '',
      },
      goal_id: {
        stamp: {
          secs: 0,
          nsecs: 0,
        },
        id: msg.operation.action_id, // 這邊要自己設計id 跟回傳 跟cancel都是參造這個id
      },
      goal: {
        request_json: JSON.stringify(msg),
      },
    });
  };
})();

// 插車回傳任務狀況
export const getReadStatus$ = (() => {
  // const schema = object({
  //   data: string().required('amr read status missed'),
  // }).required('amr detail data missed');

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: '/fleet_manager/mission/result',
    messageType: 'kenmec_fork_socket/MissionActionResult',
  });

  return fromEventPattern<MyRosMessage>((next) =>
    topic.subscribe((msg) => {
      next(msg);
    }),
  );
})();

// 主要是刪除任務
export const writeCancel = (() => {
  // Create a topic instance
  const topic = new ROSLIB.Topic({
    ros,
    name: '/kenmec_yellow/fleet_manager/cancel',
    messageType: 'actionlib_msgs/GoalID',
  });

  return (msg: ROSLIB.Message) => {
    // Publish the cancel message
    topic.publish(msg);
  };
})();
// ------------------------------------------------------------------------------ 交車主要交握




// 插車回傳任務狀況
export const getRealTimeReadStatus$ = (() => {
  const schema = object({
    data: string().required('amr read status missed '),
  }).required('amr detail data missed');

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: '/fleet_manager/real_time_read_status',
    messageType: 'std_msgs/String',
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    }),
  );
})();

// 小車氣體 
export const getGas$ = (() => {
  const schema = object({
    data: string().required('gas missed '),
  }).required('gas missed');

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: '/kenmec_yellow/gas',
    messageType: 'std_msgs/String',
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    }),
  );
})();


// 小車熱感 
export const getThermal$ = (() => {
  const schema = object({
    data: string().required('thermal missed '),
  }).required('thermal missed');

  const topic = new ROSLIB.Topic<typeof string>({
    ros,
    name: '/infraredtemp/info',
    messageType: 'std_msgs/String',
  });

  return fromEventPattern<string>((next) =>
    topic.subscribe((msg) => {
      next(schema.validateSync(msg).data);
    }),
  );
})();


export const updatePosition = (() => {
  // Create a topic instance
  const topic = new ROSLIB.Topic({
    ros,
    name: '/mission_control/update_position',
    messageType: 'std_msgs/Bool',
  });

  return (msg: ROSLIB.Message) => {
    // Publish the cancel message
    topic.publish(msg);
  };
})();


export const yellowImgLog = ((image_path: string)=>{
  const service = new ROSLIB.Service({
    ros,
    name: '/kenmec_yellow/image_log',
    serviceType: 'kenmec_yellow_socket/image_log',
  });
  const request = new ROSLIB.ServiceRequest({image_path });
  
  const schema = object({
    image_data: string().optional(),
    result: boolean().required(),
    result_msg: string().required()
  }).required('yellow img log service missed');
 

  service.callService(request, (serviceResult) =>{
    const {image_data,result,result_msg} =schema.validateSync(serviceResult)
     console.log(serviceResult)
    SOCKET.sendServiceYellowResult(image_data,result,result_msg)
  })
})
