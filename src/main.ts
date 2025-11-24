import dotenv from "dotenv";
import config from './configs'
import { cleanEnv, str } from "envalid";
import { MissionManager, MoveControl, NetWorkManager, Status } from "./service";
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
import { CANCEL_MISSION, END_MISSION, MISSION_INFO, START_MISSION, TARGET_LOC } from "./actions/mission/output";
import { IO_EX, RES_EX } from "./mq/type/type";
import { ReturnCode } from "./mq/type/returnCode";
import { MapType } from "./types/map";
import axios from "axios";
import { RabbitLoggerNormal } from "./logger/rabbitLogger";

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
  private mc: MoveControl;
  private info: { amrId: string, isConnect: boolean } = { amrId: "", isConnect: false }
  private map: MapType = { locations: [], roads: [], zones: [], regions: [] };

  constructor() {
    this.rb = new RBClient(this.info);
    this.netWorkManager = new NetWorkManager();
    this.ms = new MissionManager(this.rb, this.info);
    this.st = new Status(this.rb, this.info, this.map);
    this.mc = new MoveControl(this.rb, this.info, this.map)


    this.netWorkManager.subscribe(async (action) => {
      const { amrId } = action;
      switch (action.type) {
        case IS_CONNECTED:
          if (action.return_code == "0002") {
            RabbitLoggerNormal.info(`reset mission && traffic status`, {
              type: "reset",
              status: { return_code: action.return_code }
            });
            this.rb.flushCache(false);
            this.ms.resetMission();
            this.mc.resetStatus();
          }
          this.info.amrId = action.amrId;
          this.info.isConnect = true;
          this.isConnectWithQAMS$.next(action.isConnected);
          this.rb.flushCache(true)
          this.lastHeartbeatTime = Date.now();
          const { data } = await axios.get(`http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/test/map`);
          this.map = data;
          break;
        default:
          break;
      }
    });

    this.rb.subscribe((action) => {
      switch (action.type) {
        case RB_IS_CONNECTED:
          this.isConnectWithRabbitMQ = action.isConnected;
          break;
        default:
          break;
      }
    });

    this.ms.subscribe((action) => {
      switch (action.type) {
        case MISSION_INFO:
          const { type, ...data } = action;
          this.netWorkManager.updateMissionStatus(data);
          break;
        case TARGET_LOC:
          this.mc.setTargetLoc(action.targetLoc);
          break;
        case CANCEL_MISSION:
          this.mc.cancelMissionSignal();
          break;
        case START_MISSION:
          this.mc.startWorking();
          break
        case END_MISSION:
          this.mc.stopWorking();
          break;
        default:
          break;
      }
    });

    this.rb.onReqTransaction((action) => {
      const { payload } = action;
      switch (payload.cmd_id) {
        case CMD_ID.HEARTBEAT:
          const { heartbeat, id } = payload;
          this.lastHeartbeatTime = Date.now();
          this.lastHeartbeatCount = payload.heartbeat;
          let resHeartbeat = heartbeat + 1;
          if (resHeartbeat > 9999) {
            resHeartbeat = 0;
          }
          this.rb.resPublish(RES_EX, `amr.res.${config.MAC}.volatile`,
            sendHeartBeatResponse({
              id,
              heartbeat: resHeartbeat,
              return_code: ReturnCode.success,
              amrId: this.info.amrId
            }), { expiration: "2000" }
          )
          break;
        default:
          break;
      }
    })

    this.rb.onResTransaction((action) => {
      const { payload } = action;

      switch (payload.cmd_id) {
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

  public async init() {
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
            this.info.isConnect = false;
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
})()

