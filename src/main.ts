import dotenv from "dotenv";
import { MISSION_CONTROL_HOST, MISSION_CONTROL_PORT } from './configs'
import { cleanEnv, str } from "envalid";
import { HeartbeatMonitor, MissionManager, MoveControl, NetWorkManager, Status } from "./service";
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
import { BehaviorSubject, combineLatest, distinctUntilChanged, EMPTY, filter, from, switchMap, take, tap } from "rxjs";
import { errorLogger, infoLogger } from "./logger/logger";

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
    { missionType: "", lastSendGoalId: "", targetLoc: "", lastTransactionId: "", awaitingReconcile: true }
  // resolves once (cached) after the first ROS bridge signal or a bounded 2s timeout, so the
  // very first REGISTER after boot doesn't race a slow ROS reconnect with a stale amrHasMission
  private firstRegisterGate: Promise<void> | null = null;
  private amrStatus: AMR_STATUS =
    { amrHasMission: false, poseAccurate: false, currentId: "5305" };
  private info: TRANSACTION_INFO =
    { amrId: "", qamsSerialNum: "", session: "", return_code: "", approveNotSameSession: false }
  private connectStatus: CONNECT_STATUS =
    { qams_isConnect: false, amr_service_isConnect: false, rosbridge_isConnect: false, rabbitMQ_isConnect: false }

  private netWorkManager: NetWorkManager;
  private hb: HeartbeatMonitor;
  private rb: RBClient;
  private ms: MissionManager;
  private mc: MoveControl;
  private st: Status;
  private map: MapType = { locations: [], roads: [], zones: [], regions: [] };

  // single source of truth for the 4 upstream connections; every other service reacts to what main decides here instead of tracking its own copy
  private qams_connect$ = new BehaviorSubject<boolean>(false);
  private ros_bridge_connect$ = new BehaviorSubject<boolean>(false);
  private amr_service_connect$ = new BehaviorSubject<boolean>(false);
  private rabbit_connect$ = new BehaviorSubject<boolean>(false);

  constructor() {
    this.rb = new RBClient(this.info, this.consumedQueues, this.connectStatus);
    this.hb = new HeartbeatMonitor(this.info, this.rb, this.missionStatus, this.connectStatus)
    this.netWorkManager = new NetWorkManager(this.rb, this.amrStatus, this.missionStatus, this.connectStatus);
    this.ms = new MissionManager(this.rb, this.missionStatus, this.amrStatus);
    this.st = new Status(this.rb, this.info, this.connectStatus, this.map, this.amrStatus);
    this.mc = new MoveControl(this.rb, this.info);

    // Start consuming as soon as the AMQP channel is up (fresh connect or reconnect) - independent
    // of QAMS/rosbridge/amrService state, so consumers are already attached (no lost-message window)
    // by the time a register request goes out, and never get torn down again while the process runs.
    this.rabbit_connect$.pipe(
      distinctUntilChanged(),
      switchMap((rabbitConnect: boolean) => (rabbitConnect ? from(this.rb.consumeTopic()) : EMPTY))
    ).subscribe();

    combineLatest([
      this.qams_connect$,
      this.rabbit_connect$,
      this.ros_bridge_connect$,
      this.amr_service_connect$
    ]).pipe(
      distinctUntilChanged((prev, curr) => prev.every((value, index) => value === curr[index])),
      tap(([qamsConnect, rabbitConnect, rosbridgeConnect, amrServiceConnect]) => {
        infoLogger.info("service connect status", {
          title: "system",
          type: "connect status",
          status: {
            qamsConnect: qamsConnect ? "✅" : "❌",
            rabbitConnect: rabbitConnect ? "✅" : "❌",
            rosbridgeConnect: rosbridgeConnect ? "✅" : "❌",
            amrServiceConnect: amrServiceConnect ? "✅" : "❌"
          }
        });
        // always reflect live state, even mid-outage, so Status' publish guards (qams_isConnect)
        // actually stop status/telemetry traffic instead of staying stuck at the last "true"
        this.setServiceConnectStatus({ qamsConnect, rosbridgeConnect, rabbitConnect, amrServiceConnect });
      }),
      switchMap(([qamsConnect, rabbitConnect]) => {
        if (!rabbitConnect) return EMPTY;

        if (!qamsConnect) {
          // fleetConnect() no-ops if an attempt (incl. its own retry loop) is already in flight
          return from(this.waitForFirstRosSignal().then(() => this.netWorkManager.fleetConnect()));
        }

        return EMPTY;
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
              this.fetchMap();
            } else {
              this.setSystemStatus({ amrId, session, return_code, qamsSerialNum, approveNotSameSession: false })
            }
            this.qams_connect$.next(isConnected);
            this.hb.send(heartbeat_connectWithQAMS({ isConnected }))
          } catch (err) {
            this.hb.send(heartbeat_connectWithQAMS({ isConnected: false }))
            this.qams_connect$.next(false);
          }
          break;
        case ROS_BRIDGE_CONNECTED:
          try {
            const { isConnected } = action;
            if (!isConnected) {
              this.amrStatus.amrHasMission = undefined;
              this.amrStatus.currentId = undefined;
              this.amrStatus.poseAccurate = undefined;
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


  // Resolves once (and only once - result is cached) after ROS.connected$/rosbridge signals
  // up, or a bounded 2s timeout, whichever comes first. Gates only the very first REGISTER
  // attempt after boot, since that's the one whose amrHasMission would otherwise reflect the
  // in-memory default instead of live ROS state if RabbitMQ reconnects faster than rosbridge.
  private waitForFirstRosSignal(): Promise<void> {
    if (!this.firstRegisterGate) {
      this.firstRegisterGate = this.ros_bridge_connect$.value
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
          const timeoutId = setTimeout(() => {
            sub.unsubscribe();
            resolve();
          }, 2000);
          const sub = this.ros_bridge_connect$.pipe(filter(Boolean), take(1)).subscribe(() => {
            clearTimeout(timeoutId);
            resolve();
          });
        });
    }
    return this.firstRegisterGate;
  }

  private registerProcess(action: ReturnType<typeof isConnected>): boolean {
    const { return_code } = action;
    // every branch below means "we've now heard QAMS's authoritative view this process
    // lifetime" - ends the ambiguity window that Mission's ROS-feedback handler holds off
    // canceling for while lastSendGoalId is still empty from a fresh restart.
    this.missionStatus.awaitingReconcile = false;
    switch (return_code) {
      case ReturnCode.SUCCESS:
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_AMR_SERVICE:
        ROS.cancelCarStatusAnyway("");
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS:
        ROS.cancelCarStatusAnyway(this.missionStatus.lastSendGoalId);
        this.ms.resetMissionStatus("MISSION_NOT_SYNC_LOGIN_SUCCESS");
        return false;
      case ReturnCode.MISSION_TIMEOUT_LOGIN_SUCCESS:
        this.ms.resetMissionStatus("MISSION_TIMEOUT_LOGIN_SUCCESS");
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_RESET_STATUS_RESEND_MISSION:
        ROS.cancelCarStatusAnyway("");
        this.ms.resetMissionStatus("MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_RESET_STATUS_RESEND_MISSION");
        return false;
      case ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS:
        return true
      case ReturnCode.LOGIN_SUCCESS_UNEXPECTED:
        // both sides think they know the active goal and disagree - conservative: cancel
        // and wait, do not assume which one is right (mirrors QAMS's own conservative
        // handling of this code, which also does not auto-resend)
        ROS.cancelCarStatusAnyway("");
        this.ms.resetMissionStatus("LOGIN_SUCCESS_UNEXPECTED");
        return false;
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

  // Fire-and-forget: a slow/failed map fetch must never delay arming the heartbeat
  // watchdog or be mistaken for a QAMS connection failure (see IS_CONNECTED above).
  private async fetchMap() {
    try {
      const { data } = await axios.get(`http://${MISSION_CONTROL_HOST}:${MISSION_CONTROL_PORT}/api/test/map`, { timeout: 5000 });
      this.map = data;
    } catch (err) {
      errorLogger.error("failed to fetch map from QAMS", {
        title: "system",
        type: "map",
        status: err instanceof Error ? err.message : String(err)
      });
    }
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
