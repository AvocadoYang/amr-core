import dotenv from "dotenv";
import config from './configs'
import { cleanEnv, str } from "envalid";
import { MissionManager, MoveControl, NetWorkManager, Status, WsServer } from "./service";
import { RBClient } from "./mq";
import { BehaviorSubject, catchError, from, interval, map, timer, of, Subject, switchMap, tap } from "rxjs";
import { IS_CONNECTED, isConnected } from "./actions/networkManager/output";
import { TCLoggerNormal, TCLoggerNormalWarning } from "./logger/trafficCenterLogger";
import { CMD_ID } from "./mq/type/cmdId";
import { isDifferentPose, formatPose, SimplePose } from "./helpers";
import logger from "./logger";
import { RB_IS_CONNECTED } from "./actions/rabbitmq/output";
import { sendBaseResponse, sendHeartBeatResponse, sendPose } from "./mq/transactionsWrapper";
import { AMR_HAS_MISSION, CANCEL_MISSION, END_MISSION, MISSION_INFO, START_MISSION, TARGET_LOC } from "./actions/mission/output";
import { HEARTBEAT_EX, IO_EX, RES_EX } from "./mq/type/type";
import { ReturnCode } from "./mq/type/returnCode";
import { MapType } from "./types/map";
import axios from "axios";
import * as ROS from './ros'
import { RabbitLoggerNormal } from "./logger/rabbitLogger";
import { SysLoggerNormal, SysLoggerNormalWarning } from "./logger/systemLogger";
import { IS_REGISTERED } from "./actions/status/output";
import { number } from "yup";
import { connectWithQAMS } from "./actions/rabbitmq/input";

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
  private heartbeatSwitch$ = new Subject<boolean>();

  private lastHeartbeatTime: number = 0;
  private lastHeartbeatCount: number = 0;
  private amrStatus: { amrHasMission: boolean, amrIsRegistered: boolean } = { amrHasMission: false, amrIsRegistered: false };

  private netWorkManager: NetWorkManager;
  private rb: RBClient;
  private ms: MissionManager;
  private mc: MoveControl;
  private ws: WsServer;
  private st: Status;
  private info: { amrId: string, isConnect: boolean, session: string, return_code: string } = { amrId: "", isConnect: false, session: "", return_code: "" }
  private map: MapType = { locations: [], roads: [], zones: [], regions: [] };

  constructor() {
    this.rb = new RBClient(this.info);
    this.ws = new WsServer();
    this.netWorkManager = new NetWorkManager(this.amrStatus);
    this.ms = new MissionManager(this.rb, this.info, this.amrStatus);
    this.st = new Status(this.rb, this.info, this.map, this.amrStatus);
    this.mc = new MoveControl(this.rb, this.ws, this.info, this.map);


    this.netWorkManager.subscribe(async (action) => {
      switch (action.type) {
        case IS_CONNECTED:
          try {
            const { isConnected, amrId, session, return_code } = action;
            this.setStatus({ isConnected, amrId, session, return_code })
            if (isConnected) {
              this.registerProcess(action);
              this.rb.send(connectWithQAMS({ isConnected }));
              if (isConnected) this.heartbeatSwitch$.next(isConnected);
              const { data } = await axios.get(`http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/test/map`);
              this.map = data;
            }
          } catch (err) {
            console.log(err)
            this.heartbeatSwitch$.next(false);
          }
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
        case AMR_HAS_MISSION:
          this.amrStatus.amrHasMission = action.hasMission;
          break;
        default:
          break;
      }
    });

    this.rb.onHeartbeat((action) => {
      const { payload } = action;
      const { heartbeat, id } = payload;
      this.lastHeartbeatTime = Date.now();
      this.lastHeartbeatCount = payload.heartbeat;
      let resHeartbeat = heartbeat + 1;
      if (resHeartbeat > 9999) {
        resHeartbeat = 0;
      }

      this.rb.resPublish(HEARTBEAT_EX, `amr.heartbeat.pong.${config.MAC}`,
        sendHeartBeatResponse({
          id,
          heartbeat: resHeartbeat,
          return_code: ReturnCode.SUCCESS,
          amrId: this.info.amrId
        }), { expiration: "2000" }
      )
    })



    this.monitorHeartbeat();

  }

  public async init() {
    await this.rb.connect();
    this.netWorkManager.rosConnect();
    setTimeout(() => {
      this.netWorkManager.fleetConnect();
    }, 2000)
  }

  public monitorHeartbeat() {
    this.heartbeatSwitch$
      .pipe(
        switchMap((connected) => {
          if (connected) {
            SysLoggerNormal.info(`connect with QAMS, start heartbeat detection`, {
              type: "heartbeat",
            });
            return timer(5000, 5000).pipe(
              tap(() => {
                const now = Date.now();
                // console.log("now: ", now, "last: ", this.lastHeartbeatTime, "sub= ", now - this.lastHeartbeatTime)
                if (now - this.lastHeartbeatTime > 6000) {
                  TCLoggerNormalWarning.warn(`heartbeat timeout, disconnect`, {
                    group: "transaction",
                    type: "heartbeat",
                  });
                  this.heartbeatSwitch$.next(false);
                  this.rb.send(connectWithQAMS({ isConnected: false }))
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


  private registerProcess(action: ReturnType<typeof isConnected>) {
    const { return_code } = action;
    switch (return_code) {
      case ReturnCode.SUCCESS:
        this.rb.flushCache({ continue: true });
        break;
      /** */
      case ReturnCode.NORMAL_REGISTER:
        this.rb.flushCache({ continue: false });
        this.ms.updateStatue({ missionType: "", lastSendGoadId: "", targetLoc: "", lastTransactionId: "" });
        if (this.amrStatus.amrHasMission) ROS.cancelCarStatusAnyway("#")
        break;
      /** */
      case ReturnCode.REGISTER_SUCCESS_MISSION_NOT_EQUAL:
        if (this.ms.lastTransactionId) {
          ROS.cancelCarStatusAnyway(this.ms.lastSendGoalId);
          this.ms.updateStatue({ missionType: "", lastSendGoadId: "", targetLoc: "", lastTransactionId: "" });

        };
        this.rb.flushCache({ continue: false });
        break;
      /** */
      case ReturnCode.REGISTER_SUCCESS_AMR_NOT_REGISTER:
        this.rb.flushCache({ continue: false });
        break;
      /**  */
      default:
        break;
    }

  }

  private setStatus(data: { amrId: string, session: string, isConnected: boolean, return_code: string }) {
    const { amrId, session, isConnected, return_code } = data;
    this.info.amrId = amrId;
    this.info.isConnect = isConnected;
    this.info.session = session;
    this.info.return_code = return_code
  }


}


const amrCore = new AmrCore();
(async () => {
  await amrCore.init();
})()


