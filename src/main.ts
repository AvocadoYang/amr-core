import dotenv from "dotenv";
import config from './configs'
import { cleanEnv, str } from "envalid";
import { MissionManager, NetWorkManager, Status } from "./service";
import { RBClient } from "./mq";
import * as ROS from './ros'
import { BehaviorSubject, catchError, from, interval, map, of, switchMap, tap } from "rxjs";
import { IS_CONNECTED } from "./actions/networkManager/output";
import { TCLoggerNormal, TCLoggerNormalWarning } from "./logger/trafficCenterLogger";
import { CMD_ID } from "./mq/type/cmdId";
import { isDifferentPose, formatPose, SimplePose } from "./helpers";
import logger from "./logger";
import { RB_IS_CONNECTED } from "./actions/rabbitmq/output";
import { sendPose } from "./mq/transactionsWrapper";
import { MISSION_INFO } from "./actions/mission/output";

dotenv.config();
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

class AmrCore {
  private isConnectWithQAMS$ = new BehaviorSubject<boolean>(false);;
  private isConnectWithRabbitMQ: boolean = false;
  private lastHeartbeat: number = 0;
  private netWorkManager: NetWorkManager;
  private rb: RBClient;
  private ms: MissionManager;
  private st: Status;

  private lastPose: SimplePose = { x: 0, y: 0, yaw: 0}

  constructor(){
    this.netWorkManager = new NetWorkManager();
    this.rb = new RBClient();
    this.ms = new MissionManager(this.rb);
    this.st = new Status(this.rb);


    this.netWorkManager.subscribe((action) => {
      switch(action.type){
        case IS_CONNECTED:
          this.isConnectWithQAMS$.next(action.isConnected);
          this.lastHeartbeat = Date.now();
          break;
        default:
          break;
      }
    });

    this.rb.subscribe((action) => {
      switch(action.type){
        case RB_IS_CONNECTED:
          this.isConnectWithRabbitMQ = action.isConnected;
        break;
        default:
          break;
      }
    });

    this.ms.subscribe((action) => {
      switch(action.type){
        case MISSION_INFO:
          break;
        default:
          break;
      }
    })

    this.rb.onTransaction((action) => {
      switch(action.cmd_id){
        case CMD_ID.HEARTBEAT:
          this.lastHeartbeat = Date.now();
          this.rb.setHeartbeat(action.heartbeat);
          break;
        default:
          break;
      }
    });

    
    
  }
  
  public async init(){
    await this.rb.connect();
    this.netWorkManager.rosConnect();
    await this.netWorkManager.fleetConnect();

    /** ROS subscribe */

    ROS.pose$.subscribe((pose) => {
      if (isDifferentPose(pose, this.lastPose, 0.01, 0.01)) {
        logger.silly(`emit socket 'pose' ${formatPose(pose)}`);
      }
      const machineOffset = {
        x: -Math.sin((pose.yaw * Math.PI) / 180) * 0,
        y: -Math.cos((pose.yaw * Math.PI) / 180) * 0,
      };
      const Pose = { x:pose.x + machineOffset.x, y: pose.y + machineOffset.y, yaw: pose.yaw }
      this.rb.sendToReqQueue(`pose/${config.MAC}/REQ`, sendPose(Pose), CMD_ID.POSE);
      this.lastPose = pose;
    });
  }

  public monitorHeartbeat() {
    this.isConnectWithQAMS$
      .pipe(
        switchMap((connected) => {
          if (connected) {
            TCLoggerNormal.info(`connect with QAMS, start heartbeat detection`, {
              group: "transaction",
              type: "heartbeat",
            });
            this.rb.switchHeartbeat(true);

            return interval(1000).pipe(
              tap(() => {
                const now = Date.now();
                if (now - this.lastHeartbeat > 6000) {
                  TCLoggerNormalWarning.warn(`heartbeat timeout, disconnect`, {
                    group: "transaction",
                    type: "heartbeat",
                  });
                  this.rb.switchHeartbeat(false);
                  this.isConnectWithQAMS$.next(false);
                }
              })
            );
          } else {
            return from(this.retryConnectWithDelay(1500)).pipe(
              catchError((err) => {
                TCLoggerNormalWarning.warn(`reconnect failed: ${err}`);
                return of();
              })
            );
          }
        })
      )
      .subscribe();
  }

  private async retryConnectWithDelay(delayMs: number) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await this.netWorkManager.fleetConnect();
  }


}


const amrCore = new AmrCore();

(async () => { 
  await amrCore.init();
  amrCore.monitorHeartbeat();

  
   
} )()

