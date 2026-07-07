import dotenv from "dotenv";
import { MISSION_CONTROL_HOST, MISSION_CONTROL_PORT } from './configs'
import { cleanEnv, str } from "envalid";
import { HeartbeatMonitor, MissionManager, MoveControl, NetWorkManager, Status, WsServer } from "./service";
import { RBClient } from "./mq";
import { IS_CONNECTED, isConnected, ROS_BRIDGE_CONNECTED } from "./actions/networkManager/output";
import { RB_IS_CONNECTED } from "./actions/rabbitmq/output";
import { ReturnCode } from "./mq/type/returnCode";
import { MapType } from "./types/map";
import axios from "axios";
import * as ROS from './ros'
import { connectWithQAMS as heartbeat_connectWithQAMS } from './actions/heartbeatMonitor/input'
import { AMR_SERVICE_ISCONNECTED, QAMS_DISCONNECTED } from "./actions/heartbeatMonitor/output";
import { AMR_STATUS, CONNECT_STATUS, MISSION_STATUS, TRANSACTION_INFO } from "./types/status";
import { BehaviorSubject, combineLatest, distinctUntilChanged, delay, EMPTY, from, switchMap, tap } from "rxjs";
import { infoLogger } from "./logger/logger";
import { dynamicListener } from "./mq/type/type";

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
  private consumedQueues: Map<string, string> = new Map();
  private missionStatus: MISSION_STATUS =
    { missionType: "", lastSendGoalId: "", targetLoc: "", lastTransactionId: "" }
  private amrStatus: AMR_STATUS =
    { amrHasMission: false, poseAccurate: undefined, currentId: undefined };
  private info: TRANSACTION_INFO =
    { amrId: "", qamsSerialNum: "", session: "", return_code: "", approveNotSameSession: false }
  private connectStatus: CONNECT_STATUS =
    { qams_isConnect: false, amr_service_isConnect: false, rosbridge_isConnect: false, rabbitMQ_isConnect: false }

  private netWorkManager: NetWorkManager;
  private hb: HeartbeatMonitor;
  private rb: RBClient;
  private ms: MissionManager;
  private mc: MoveControl;
  private ws: WsServer;
  private st: Status;
  private map: MapType = { locations: [], roads: [], zones: [], regions: [] };

  // single source of truth for the 4 upstream connections; every other service reacts to what main decides here instead of tracking its own copy
  private qams_connect$ = new BehaviorSubject<boolean>(false);
  private ros_bridge_connect$ = new BehaviorSubject<boolean>(false);
  private amr_service_connect$ = new BehaviorSubject<boolean>(false);
  private rabbit_connect$ = new BehaviorSubject<boolean>(false);

  // guards against firing a second QAMS reconnect while one (including its internal retry loop) is already in flight
  private reconnectingQams = false;

  constructor() {
    this.rb = new RBClient(this.info, this.consumedQueues, this.connectStatus);
    this.hb = new HeartbeatMonitor(this.info, this.rb, this.missionStatus)
    this.ws = new WsServer();
    this.netWorkManager = new NetWorkManager(this.amrStatus, this.missionStatus);
    this.ms = new MissionManager(this.rb, this.missionStatus, this.amrStatus);
    this.st = new Status(this.rb, this.info, this.connectStatus, this.map, this.amrStatus);
    this.mc = new MoveControl(this.rb, this.info);

    combineLatest([
      this.qams_connect$,
      this.ros_bridge_connect$,
      this.rabbit_connect$,
      this.amr_service_connect$
    ]).pipe(
      distinctUntilChanged((prev, curr) => prev.every((value, index) => value === curr[index])),
      tap(([qamsConnect, rosbridgeConnect, rabbitConnect, amrServiceConnect]) => {
        infoLogger.info("service connect status", {
          title: "system",
          type: "connect status",
          status: {
            qamsConnect: qamsConnect ? "✅" : "❌",
            rosbridgeConnect: rosbridgeConnect ? "✅" : "❌",
            rabbitConnect: rabbitConnect ? "✅" : "❌",
            amrServiceConnect: amrServiceConnect ? "✅" : "❌"
          }
        });
      }),
      switchMap(([qamsConnect, rosbridgeConnect, rabbitConnect, amrServiceConnect]) => {
        const dependenciesReady = rosbridgeConnect && rabbitConnect && amrServiceConnect;

        if (!dependenciesReady) {
          this.reconnectingQams = false;
          return from(this.rb.stopConsumeQueue(dynamicListener));
        }

        if (!qamsConnect) {
          if (this.reconnectingQams) return EMPTY;
          this.reconnectingQams = true;
          // must finish unsubscribing from every queue before opening a new QAMS session, otherwise a stale consumer can still be draining messages tied to the old session while the new handshake starts
          return from(this.rb.stopConsumeQueue(dynamicListener)).pipe(
            delay(1500),
            tap(() => this.netWorkManager.fleetConnect())
          );
        }

        this.reconnectingQams = false;
        return from(this.rb.consumeTopic()).pipe(
          tap(() => {
            this.setServiceConnectStatus({
              qamsConnect,
              rosbridgeConnect,
              rabbitConnect,
              amrServiceConnect,
            });
            this.rb.clearCache();
          }),
          tap(() =>
            this.hb.send(
              heartbeat_connectWithQAMS({
                isConnected: true,
              })
            )
          )
        );
      })
    ).subscribe();

    this.netWorkManager.subscribe(async (action) => {
      switch (action.type) {
        case IS_CONNECTED:
          try {
            const { isConnected, amrId, session, return_code, qamsSerialNum } = action;
            if (isConnected) {
              this.info.qamsSerialNum = qamsSerialNum;
              this.setSystemStatus({ amrId, session, return_code, qamsSerialNum, approveNotSameSession: this.registerProcess(action) })
              const { data } = await axios.get(`http://${MISSION_CONTROL_HOST}:${MISSION_CONTROL_PORT}/api/test/map`);
              this.map = data;
            } else {
              this.setSystemStatus({ amrId, session, return_code, qamsSerialNum, approveNotSameSession: false })
            }
            this.qams_connect$.next(isConnected);
          } catch (err) {
            this.hb.send(heartbeat_connectWithQAMS({ isConnected: false }))
            this.qams_connect$.next(false);
          }
          break;
        case ROS_BRIDGE_CONNECTED:
          try {
            const { isConnected } = action;
            if (!isConnected) {
              this.amrStatus = { amrHasMission: undefined, poseAccurate: undefined, currentId: undefined };
            }
            this.ros_bridge_connect$.next(isConnected);
          } catch {
            this.ros_bridge_connect$.next(false);
          }
          break;
        default:
          break;
      }
    });

    this.rb.subscribe((action) => {
      switch (action.type) {
        case RB_IS_CONNECTED:
          this.rabbit_connect$.next(action.isConnected);
          break;
        default:
          break;
      }
    });

    this.hb.subscribe((action) => {
      switch (action.type) {
        case QAMS_DISCONNECTED:
          this.qams_connect$.next(action.isConnected);
          break;
        case AMR_SERVICE_ISCONNECTED:
          this.amr_service_connect$.next(action.isConnected);
          if (!action.isConnected) {
            this.resetAmrStatus();
          }
          break;
        default:
          break;
      }
    })

  }


  private registerProcess(action: ReturnType<typeof isConnected>): boolean {
    const { return_code } = action;
    switch (return_code) {
      case ReturnCode.SUCCESS:
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_AMR_SERVICE:
        ROS.cancelCarStatusAnyway("");
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS:
        ROS.cancelCarStatusAnyway(this.missionStatus.lastSendGoalId);
        this.ms.resetMissionStatus();
        return false;
      case ReturnCode.MISSION_TIMEOUT_LOGIN_SUCCESS:
        this.ms.resetMissionStatus();
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_RESET_STATUS_RESEND_MISSION:
        ROS.cancelCarStatusAnyway("");
        this.ms.resetMissionStatus();
        return false;
      case ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS:
        return true
      default:
        return false
    }

  }

  private setSystemStatus(data: TRANSACTION_INFO) {
    const { amrId, session, return_code, approveNotSameSession } = data;
    this.info.amrId = amrId;
    this.info.session = session;
    this.info.return_code = return_code
    this.info.approveNotSameSession = approveNotSameSession
  }

  private resetAmrStatus() {
    this.amrStatus.amrHasMission = undefined;
    this.amrStatus.currentId = undefined;
    this.amrStatus.poseAccurate = undefined;
  }


  private setServiceConnectStatus(status:
    { qamsConnect: boolean, rosbridgeConnect: boolean, rabbitConnect: boolean, amrServiceConnect: boolean }
  ) {
    this.connectStatus.qams_isConnect = status.qamsConnect;
    this.connectStatus.rosbridge_isConnect = status.rosbridgeConnect;
    this.connectStatus.rabbitMQ_isConnect = status.rabbitConnect;
    this.connectStatus.amr_service_isConnect = status.amrServiceConnect;
  }
}

new AmrCore();
