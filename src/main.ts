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
import { sendBaseResponse, sendHeartBeatResponse, sendPose } from "./mq/transactionsWrapper";
import { MISSION_INFO } from "./actions/mission/output";
import { IO_EX, RES_EX } from "./mq/type/type";
import { ReturnCode } from "./mq/type/returnCode";

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
  private isConnectWithQAMS$ = new BehaviorSubject<boolean>(false);
  private isConnectWithRabbitMQ: boolean = false;
  private lastHeartbeatTime: number = 0;
  private lastHeartbeatCount: number = 0;
  private netWorkManager: NetWorkManager;
  private rb: RBClient;
  private ms: MissionManager;
  private st: Status;
  private amrId: string;

  constructor(){
    this.netWorkManager = new NetWorkManager();
    this.rb = new RBClient();
    this.ms = new MissionManager(this.rb);
    this.st = new Status(this.rb);


    this.netWorkManager.subscribe((action) => {
      switch(action.type){
        case IS_CONNECTED:
          this.isConnectWithQAMS$.next(action.isConnected);
          this.amrId = action.amrId;
          this.rb.setAmrId(action.amrId);
          this.ms.setAmrId(action.amrId);
          this.st.setAmrId(action.amrId);
          this.lastHeartbeatTime = Date.now();
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
    });

    this.rb.onReqTransaction((action) => {
      const { payload } = action;
      switch(payload.cmd_id){
        case CMD_ID.HEARTBEAT:
          const { heartbeat, id} = payload;
          this.lastHeartbeatTime = Date.now();
          this.lastHeartbeatCount = payload.heartbeat;
          let resHeartbeat = heartbeat+1;
          if (resHeartbeat > 9999) {
            resHeartbeat = 0;
          }
          this.rb.resPublish(RES_EX, `amr.res.${config.MAC}.volatile`,
             sendHeartBeatResponse({ 
              id, 
              heartbeat: resHeartbeat,
              return_code: ReturnCode.success, 
              amrId: this.amrId})
            )
          break;
        default:
          break;
      }
    })

    this.rb.onResTransaction((action) => {
      const { payload } = action;
      
      switch(payload.cmd_id){
        case CMD_ID.READ_STATUS:
          break;
        case CMD_ID.CARGO_VERITY:
          console.log(action, '@@@@@@@')
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

            return interval(1000).pipe(
              tap(() => {
                const now = Date.now();
                if (now - this.lastHeartbeatTime > 3000) {
                  TCLoggerNormalWarning.warn(`heartbeat timeout, disconnect`, {
                    group: "transaction",
                    type: "heartbeat",
                  });
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
      ).subscribe();
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

