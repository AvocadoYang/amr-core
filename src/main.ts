//version 2024/08/22
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
  tap,
  Subscription,
  timeout,
  throwError,
  catchError,
  BehaviorSubject,
  throttleTime,
} from 'rxjs';
import macaddress from 'macaddress';
import chalk from 'chalk';
import { object, string, number, boolean } from 'yup';
import logger from './logger';
import * as ROS from './ros';
import * as SOCKET from './socket';
import config from './config';
import { isDifferentPose, SimplePose, TrafficGoal } from './helpers/geometry';
import { formatPose } from './helpers';
import { MyRosMessage, WriteStatus, isLocationIdAndIsAllow } from './types/fleetInfo';
import initWrite from './helpers/initData';


async function bootstrap() {
  let lastGoal: number = null;
  const currentGoal: TrafficGoal = null;
  const mac = 'aa:96:31:94:f6:72';
  let lastSendGoalId: string = '';
  let lastLocId: number = 0;
  let lastPose: SimplePose = { x: 0, y: 0, yaw: 0 };
  let targetLoc: string;
  let missionType: string = '';
  let accMoveAction: string;
  let lastWriteStatus: string = JSON.stringify(initWrite);
  let lastShortestPath: string[];
  let getLeaveLoc$: Subscription;
  let getArriveLoc$: Subscription;
  let reconnectCount$: BehaviorSubject<number> = new BehaviorSubject(0)
  SOCKET.init(mac);
  ROS.init();
  ROS.connected$.subscribe(() => {
    logger.info(`Connected to ROS Bridge ${config.ROS_BRIDGE_URL}`);
    SOCKET.sendRosBridgeConnection(true)
    reconnectCount$.next(reconnectCount$.value + 1)

  });
  ROS.connectionError$.subscribe((error: Error) => {
    logger.warn(`ROS Bridge connect error: ${JSON.stringify(error)}`);
    SOCKET.sendRosBridgeConnection(false)
    lastSendGoalId = '';
  });

  reconnectCount$.pipe(
    filter((v) => v > 1)
  ).subscribe((count)=>{
    logger.info(`ROSBRIDGE HAS BEEN RECONNECTED FOR ${count} TIMES!`);

    setTimeout(() => {
      SOCKET.sendRetryConnect(count)
    }, 1000);
  })



  ROS.connectionClosed$.subscribe(() => {
    lastGoal = null;
    logger.info('ROS Bridge Connection closed');
    ROS.cancelCarStatusAnyway()
    SOCKET.sendRosBridgeConnection(false)
    lastSendGoalId = '';
  });

  SOCKET.disconnect$.subscribe(()=> {
    logger.info('ROS Bridge Connection closed');
    ROS.cancelCarStatusAnyway()
  })




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
    SOCKET.sendPose(
      pose.x + machineOffset.x,
      pose.y + machineOffset.y,
      pose.yaw,
    );
    lastPose = pose;
  });

  ROS.getReadStatus$.subscribe((data) => {
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
        feedback_id: data.status.goal_id.id,// 我們的uid
        action_status: data.status.status,   
        result_status: data.result.result_status,
        result_message: data.result.result_message,
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
    console.log(new Date().toLocaleString())
    console.log(`🐝 ${chalk.magenta('mission complete')} 🐝`);
    console.log('\n', '==========');

    if (accMoveAction === 'move') {
      console.log('arrived at destination', targetLoc);
      SOCKET.sendReachGoal(targetLoc);
      missionType = '';
      targetLoc = '';
      setTimeout(() => {
        SOCKET.sendReadStatus(JSON.stringify(newState));
      }, 1000)
      return
    }
    interval(500).pipe(
      take(2)
    ).subscribe(()=>{
      SOCKET.sendReadStatus(JSON.stringify(newState));
    })

    
  });

  /** 任務完成訊號 Action Result */
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
          wait: v.action.operation.wait,
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
          auto_preparatory_point: v.action.operation.auto_preparatory_point,
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
      targetLoc = msg.move.goal_id.toString();
      missionType = msg.operation.type;
      ROS.writeStatus(msg);
    } else {
      ROS.writeStatus(msg);
    }
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
  ROS.getFeedbackFromMoveAction$
  .subscribe((Feedback) => {
    const { status, feedback } = Feedback;
    const actionId = status.goal_id.id;
    if(lastSendGoalId !== actionId){
      console.log(chalk.bgRed(`execute action ID: ${lastSendGoalId} not equal to feedback action ID: ${actionId}`));
      return;
    }
    if (!actionId) return;
    SOCKET.sendWriteStateFeedback(feedback.feedback_json);
  });


  SOCKET.yellowImgLog$.subscribe(({imgPath})=>{
    ROS.yellowImgLog(imgPath)
  })

  SOCKET.writeCancel$.subscribe(({ id }) => {
    const cancelMessage: ROSLIB.Message = {
      stamp: {
        secs: 0,
        nsecs: 0,
      },
      id,
    };
    if(missionType === 'move'){
      if(getLeaveLoc$){
        getLeaveLoc$.unsubscribe();
      }
      if(getArriveLoc$){
        getArriveLoc$.unsubscribe();
      }
    }
    ROS.cancelCarStatusAnyway()
    ROS.writeCancel(cancelMessage);
  });


  /** 註冊時會訂閱的一次性 Subscription
   *  用於等待車輛回應以抵達註冊點
  */
  
  SOCKET.startOneTermAllowPath$.pipe(tap((data) => console.log(data)),switchMap(() => {
    console.log('Star wait arriving')
    return (
    ROS.getArriveTarget$.pipe(take(1))
  )})).subscribe(
    {
      next:(isArriveRes) => {
        logger.info(
          `Arrive location ${isArriveRes.data}  is received successful`,
        );
        const resData = (isArriveRes as { data: string }).data;

        const parseData = JSON.parse(resData);
        SOCKET.sendIsArriveLocation(parseData)
        SOCKET.sendReachGoal(parseData.locationId);

      },
    }
  )

  /** 接收最短路徑 Subscription */
  SOCKET.shortestPath$.pipe(
    tap((shortestPath) =>{ lastShortestPath = shortestPath.shortestPath})
    ,ROS.shortestPath())
    .subscribe();

  /** 通行權 (isAllow: true/false) Subscription */
  SOCKET.allowPath$.pipe(filter(isLocationIdAndIsAllow))
  .subscribe((allowTarget) => {
    if(allowTarget.isAllow){
      console.log(`allow location ${allowTarget.locationId} @@@@@@@@@@@`)
      getArriveLoc$ = ROS.getArriveTarget$.pipe(take(1)).subscribe((isArriveRes) => {
        logger.info(
          `Arrive location ${isArriveRes.data}  is received successful`,
        );
        const resData = (isArriveRes as { data: string }).data;
        SOCKET.sendIsArriveLocation(JSON.parse(resData));
        const parseData = JSON.parse(resData);
        if(targetLoc === allowTarget.locationId){
          SOCKET.sendReachGoal(parseData.locationId);
        }
      });
      if(targetLoc !== allowTarget.locationId){
        console.log('create leave location Observerble!!!!!!!!!!, now allow =', allowTarget.locationId)
        getLeaveLoc$ = ROS.getLeaveLocation$.pipe(
          filter((response) => {
            const Loc = JSON.parse(response.data).locationId;
            return Loc === allowTarget.locationId
          }),
          take(1))
          .subscribe((leaveLocation) => {
          const leaveLoc = JSON.parse(leaveLocation.data);
          console.log('leave location = ', leaveLoc.locationId)
          if(!lastShortestPath.length) return;
          SOCKET.sendIsLeaveLocation(leaveLocation);
        })
      }
    }
      ROS.allowTarget(
        allowTarget as {
          locationId: string;
          isAllow: boolean;
        },
      );
  })

  ROS.getAmrError$.subscribe((msg: { data: string})=>{
    const trans = JSON.parse(msg.data)
    SOCKET.sendCarErrorInfo(trans)
  })


  ROS.getRealTimeReadStatus$.subscribe((data) => {
    SOCKET.sendRealTimeReadStatus(data)
  })


  ROS.getGas$.subscribe((data) => {
    SOCKET.sendGas(data)
  })
  
  ROS.getThermal$.subscribe((data) => {
    // console.log(data)
    SOCKET.sendThermal(data)
  })  

  SOCKET.updatePosition$.subscribe((data)=>{
    ROS.updatePosition({data: data.isUpdate})
  })  
  ROS.getIOInfo$.subscribe((data) => {
    SOCKET.sendIOInfo(data);
  });

  SOCKET.yellowImgLog$.subscribe(({imgPath})=>{
    ROS.yellowImgLog(imgPath)
  })

  // SOCKET.cancelAnyways$.subscribe(()=>{
  //   ROS.cancelCarStatusAnyway()
  // })


  ROS.topicTask$.subscribe((msg)=>{
    SOCKET.topicTask(msg)
  })

  ROS.currentId$.pipe(
    throttleTime(5000)
  ).subscribe((currentId) => {
    SOCKET.sendCurrentId(currentId)
  })

  ROS.cancelCarStatusAnyway()
  logger.info('AMR Core Started, Waiting for ROS and SocketIO connection...');
  // fleetMoveMock(SOCKET, notifyMoveStart$);
}

void bootstrap();
