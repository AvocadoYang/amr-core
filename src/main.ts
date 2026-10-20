import dotenv from "dotenv";
import { randomUUID } from "crypto";
import { MAC, MISSION_CONTROL_HOST, MISSION_CONTROL_PORT } from './configs'
import { cleanEnv, str } from "envalid";
import { CarState, Diagnostics, HeartbeatMonitor, MissionManager, MoveControl, NetWorkManager, Status } from "./service";
import { loadMissionState } from "./service/missionStateStore";
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
import { BehaviorSubject, catchError, combineLatest, concatMap, distinctUntilChanged, EMPTY, filter, from, ignoreElements, map, merge, Observable, share, switchMap, take, takeUntil, tap, timer } from "rxjs";
import { errorLogger, infoLogger, warnLogger } from "./logger/logger";
import { HANDSHAKE_EX, IO_EX } from "./mq/type/type";
import { sendConnectionHealth, sendResendMissionRequest } from "./mq/transactionsWrapper";
import { CMD_ID } from "./mq/type/cmdId";
import { ConnectionHealthRes } from "./mq/type/res";

// CONNECTION_HEALTH is resent with the same id until QAMS answers it - a lost request or
// answer would otherwise leave the gate closed for good while the heartbeat looks fine
const CH_RETRY_MS = 3000;
// how long the ready gate waits for the AMR to publish has_mission before asking QAMS anyway
const CAR_STATE_WAIT_MS = 3000;
// a goal forwarded this recently may not show in has_mission / feedback yet (e.g. it was
// queued during a stall and delivered right before the reconnect) - give the AMR this long
// to report it before the reconcile takes its snapshot
const FRESH_GOAL_WAIT_MS = 5000;
// tells QAMS this amr-core reports carHasMission / runningGoalId / pendingReadStatus and
// understands settledReadStatusId / adoptGoalId / 3007 in the answer
const RECONCILE_VERSION = 2;

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

type Connections = [qamsConnect: boolean, rabbitConnect: boolean, rosbridgeConnect: boolean, amrServiceConnect: boolean];

class AmrCore {
  private consumedQueues: Map<string, string> = new Map();
  private missionStatus: MISSION_STATUS =
    { missionType: "", lastSendGoalId: "", targetLoc: "", lastTransactionId: "", awaitingReconcile: true, pendingReadStatus: null }
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
  private carState: CarState;
  private diag: Diagnostics;

  // single source of truth for the 4 upstream connections; every other service reacts to what main decides here instead of tracking its own copy
  private qams_connect$ = new BehaviorSubject<boolean>(false);
  private ros_bridge_connect$ = new BehaviorSubject<boolean>(false);
  private amr_service_connect$ = new BehaviorSubject<boolean>(false);
  private rabbit_connect$ = new BehaviorSubject<boolean>(false);

  constructor() {
    // the goal / unacked result from before a restart - restored before any service reads it
    const stored = loadMissionState();
    if (stored) Object.assign(this.missionStatus, stored);

    this.rb = new RBClient(this.info, this.consumedQueues, this.connectStatus);
    this.carState = new CarState();
    this.diag = new Diagnostics(this.info, this.missionStatus, this.amrStatus, this.carState);
    this.hb = new HeartbeatMonitor(this.info, this.rb, this.missionStatus, this.connectStatus, this.diag)
    this.netWorkManager = new NetWorkManager(this.rb, this.amrStatus, this.missionStatus, this.connectStatus);
    this.diag.attachSources({
      qamsError: () => this.netWorkManager.lastError,
      rabbitError: () => this.rb.lastNetworkError,
      heartbeat: () => this.hb.getHeartbeatTimes(),
    });
    this.ms = new MissionManager(this.rb, this.missionStatus, this.amrStatus, this.carState);
    this.st = new Status(this.rb, this.info, this.connectStatus, this.amrStatus);
    this.mc = new MoveControl(this.rb, this.info);

    // log + mirror the connections into connectStatus, and (re)register with QAMS whenever
    // RabbitMQ is up but QAMS is not
    this.connections$().pipe(
      tap(async ([qamsConnect, rabbitConnect, rosbridgeConnect, amrServiceConnect]) => {
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

        this.setServiceConnectStatus({ qamsConnect, rosbridgeConnect, rabbitConnect, amrServiceConnect });
        this.diag.setLinks({ qams: qamsConnect, rabbit: rabbitConnect, ros: rosbridgeConnect, amrService: amrServiceConnect });
      }),
      switchMap(([qamsConnect, rabbitConnect]) => {
        // topology is declared by the rabbit client's recovery setup before it reports connected
        if (!rabbitConnect || qamsConnect) return EMPTY;
        return from(this.waitForFirstRosSignal()).pipe(
          tap(() => this.netWorkManager.fleetConnect())
        );
      })
    ).subscribe();

    // the ready gate: the dynamic consumers and the outbox only run once QAMS has reconciled
    // its mission state with what this amr-core and the AMR know
    this.connections$().pipe(
      switchMap((connections) => {
        const [qamsConnect, rabbitConnect, rosbridgeConnect, amrServiceConnect] = connections;
        if (qamsConnect && rabbitConnect && rosbridgeConnect && amrServiceConnect) {
          return this.reconcileWithQams$();
        }
        return from(this.holdUntilReady(connections));
      })
    ).subscribe();

    this.netWorkManager.subscribe(async (action) => {
      switch (action.type) {
        case IS_CONNECTED:
          try {
            const { isConnected, amrId, session, qamsSerialNum } = action;
            this.setSystemStatus({ amrId, session, qamsSerialNum });
            this.qams_connect$.next(isConnected);
            this.hb.send(heartbeat_connectWithQAMS({ isConnected }));
          } catch (err) {
            this.hb.send(heartbeat_connectWithQAMS({ isConnected: false }));
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

  private connections$(): Observable<Connections> {
    return combineLatest([
      this.qams_connect$,
      this.rabbit_connect$,
      this.ros_bridge_connect$,
      this.amr_service_connect$
    ]).pipe(
      distinctUntilChanged((prev, curr) => prev.every((value, index) => value === curr[index]))
    ) as Observable<Connections>;
  }

  private async holdUntilReady([qamsConnect, rabbitConnect, rosbridgeConnect, amrServiceConnect]: Connections) {
    const disconnected = [
      !qamsConnect && "QAMS",
      !rabbitConnect && "RabbitMQ",
      !rosbridgeConnect && "ROS Bridge",
      !amrServiceConnect && "AMR Service",
    ].filter(Boolean).join(", ");
    // a new session is coming - hold reliable messages until it is settled
    this.rb.closeOutbox();
    this.diag.reconcileEnd();
    try {
      await this.rb.pauseDynamicConsumers(`disconnect service: ${disconnected}`);
    } catch (err) {
      errorLogger.error(`pause consumers failed: ${err instanceof Error ? err.message : String(err)}`, {
        title: "system",
        type: "connect status"
      });
    }
    // still registered with QAMS but the AMR side is down: say so, so QAMS stops sending new
    // missions here - it keeps the current one and reconciles once everything is back
    if (qamsConnect && rabbitConnect) {
      this.rb.reqPublish(
        HANDSHAKE_EX,
        `qams.register.req.checkHealth.${MAC}`,
        this.connectionHealthMessage(rosbridgeConnect, amrServiceConnect),
        { expiration: String(CH_RETRY_MS) }
      );
    }
  }

  private connectionHealthMessage(rosbridgeConnect: boolean, amrServiceConnect: boolean) {
    return sendConnectionHealth({
      rosbridgeConnect,
      amrServiceConnect,
      lastSendGoalId: this.missionStatus.lastSendGoalId,
      amrHasMission: this.amrStatus.amrHasMission,
      pendingReadStatus: this.missionStatus.pendingReadStatus,
      carHasMission: this.carState.getHasMission(),
      runningGoalId: this.carState.getRunningGoalId(),
      reconcileVersion: RECONCILE_VERSION,
    });
  }

  private async waitForCarState() {
    await this.carState.waitForHasMission(CAR_STATE_WAIT_MS);
    const until = Date.now() + FRESH_GOAL_WAIT_MS;
    while (this.ms.goalJustSent(FRESH_GOAL_WAIT_MS) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private reconcileWithQams$(): Observable<unknown> {
    this.diag.reconcileBegin();
    return from(this.waitForCarState()).pipe(
      switchMap(() => this.askQamsToReconcile$()),
      concatMap((answer) => from(this.applyReconcile(answer))),
      catchError((err) => {
        errorLogger.error(`reconcile with QAMS failed: ${err instanceof Error ? err.message : String(err)}`, {
          title: "system",
          type: "connect status"
        });
        return EMPTY;
      })
    );
  }

  /** CONNECTION_HEALTH with one id, resent until QAMS answers that id */
  private askQamsToReconcile$(): Observable<ConnectionHealthRes> {
    const id = randomUUID();
    // built once: every resend is the same request, so QAMS answers a resend from its cache
    // instead of reconciling (and issuing a session) a second time
    const message = this.connectionHealthMessage(true, true);
    const answer$ = this.rb.registerResTransactionOutput$.pipe(
      filter((action) => action.payload.cmd_id === CMD_ID.CONNECTION_HEALTH && action.payload.id === id),
      map((action) => action.payload as ConnectionHealthRes),
      take(1),
      share()
    );
    const ask$ = timer(0, CH_RETRY_MS).pipe(
      tap((attempt) => {
        this.diag.reconcileAttempt();
        if (attempt > 0) {
          warnLogger.warn(`no answer to CONNECTION_HEALTH yet, resend (${attempt})`, {
            title: "system",
            type: "connect status",
            status: { id }
          });
        }
        this.rb.reqPublish(
          HANDSHAKE_EX,
          `qams.register.req.checkHealth.${MAC}`,
          message,
          { expiration: String(CH_RETRY_MS) },
          id
        );
      }),
      takeUntil(answer$),
      ignoreElements()
    );
    return merge(ask$, answer$);
  }

  private async applyReconcile(answer: ConnectionHealthRes) {
    // the session is settled - everything from here on, and everything released from the
    // outbox, carries the session QAMS now accepts
    this.setSystemStatus({ session: answer.newSession });
    const { approveNotSameSession, resendMission } = this.registerProcess(answer);
    this.info.approveNotSameSession = approveNotSameSession;
    if (this.info.approveNotSameSession) {
      infoLogger.info("start consume qams handshake queue, accept not equal session", {
        amrId: "Rabbitmq",
        type: "create consumer"
      })
    } else {
      infoLogger.info("start consume qams handshake queue, just accept equal session", {
        amrId: "Rabbitmq",
        type: "create consumer"
      })
    }
    try {
      await this.rb.consumeDynamicTopic();
    } catch (err) {
      // rabbit dropped again mid-reconcile - its reconnect re-runs this whole gate
      errorLogger.error(`consume topic failed: ${err instanceof Error ? err.message : String(err)}`, {
        title: "system",
        type: "connect status"
      });
      return;
    }
    // release everything held while disconnected, stamped with the session QAMS now accepts
    this.rb.openOutbox();
    if (resendMission) {
      this.rb.reqPublishWithAck(
        HANDSHAKE_EX,
        `qams.${MAC}.handshake.resend_mission_request`,
        sendResendMissionRequest()
      )
    }
  }

  private registerProcess(answer: ConnectionHealthRes): { approveNotSameSession: boolean, resendMission: boolean } {
    const { return_code, settledReadStatusId, adoptGoalId } = answer;
    this.diag.setReconcile(return_code, answer.message);
    this.diag.reconcileEnd();
    // every branch below means "we've now heard QAMS's authoritative view this process
    // lifetime" - ends the ambiguity window that Mission's ROS-feedback handler holds off
    // canceling for while lastSendGoalId is still empty from a fresh restart.
    this.missionStatus.awaitingReconcile = false;
    // a goal-lost report queued before this reconcile describes a state QAMS just re-judged
    this.ms.discardLostReport();
    // QAMS has settled a result we were still holding (applied it, or it was for a goal QAMS
    // no longer runs) - drop it so neither the outbox nor a restart delivers it again
    if (settledReadStatusId) this.ms.dropPendingReadStatus(settledReadStatusId, `CONNECTION_HEALTH ${return_code}`);
    infoLogger.info("reconcile result from QAMS", {
      title: "system",
      type: "connect status",
      status: { return_code, message: answer.message, settledReadStatusId, adoptGoalId }
    });
    switch (return_code) {
      case ReturnCode.SUCCESS:
        return { approveNotSameSession: false, resendMission: false };
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_AMR_SERVICE:
        ROS.cancelCarStatusAnyway("");
        this.ms.resetMissionStatus("MISSION_NOT_SYNC_LOGIN_SUCCESS");
        return { approveNotSameSession: false, resendMission: false };
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS:
        this.ms.resetMissionStatus("MISSION_NOT_SYNC_LOGIN_SUCCESS");
        ROS.cancelCarStatusAnyway(this.missionStatus.lastSendGoalId);
        return { approveNotSameSession: false, resendMission: false };
      case ReturnCode.MISSION_TIMEOUT_LOGIN_SUCCESS:
        this.ms.resetMissionStatus("MISSION_TIMEOUT_LOGIN_SUCCESS");
        return { approveNotSameSession: false, resendMission: true };
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_RESET_STATUS_RESEND_MISSION:
        ROS.cancelCarStatusAnyway("");
        this.ms.resetMissionStatus("MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_RESET_STATUS_RESEND_MISSION");
        return { approveNotSameSession: false, resendMission: true };
      case ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS:
        // the AMR is running the goal QAMS waits for but our record of it was lost
        if (adoptGoalId) this.ms.adoptGoal(adoptGoalId);
        return { approveNotSameSession: true, resendMission: false }
      case ReturnCode.MISSION_COMPLETED_DURING_DISCONNECT:
        // the goal finished while disconnected and QAMS already applied the result we carried
        // in CH.pendingReadStatus - nothing to cancel or resend, just drop the local record
        this.ms.resetMissionStatus("MISSION_COMPLETED_DURING_DISCONNECT");
        this.amrStatus.amrHasMission = false;
        return { approveNotSameSession: false, resendMission: false };
      case ReturnCode.MISSION_RESULT_UNKNOWN:
        // QAMS can not tell whether the AMR finished this step and asked a person to check on
        // site: keep the record (a late result is still reported) and leave the AMR alone
        warnLogger.warn(`QAMS can not tell whether goal ${this.missionStatus.lastSendGoalId} finished, waiting for a person to check`, {
          title: "system",
          type: "connect status"
        });
        return { approveNotSameSession: false, resendMission: false };
      case ReturnCode.LOGIN_SUCCESS_UNEXPECTED:
        // both sides think they know the active goal and disagree - conservative: cancel
        // and wait, do not assume which one is right (mirrors QAMS's own conservative
        // handling of this code, which also does not auto-resend)
        ROS.cancelCarStatusAnyway("");
        this.ms.resetMissionStatus("LOGIN_SUCCESS_UNEXPECTED");
        return { approveNotSameSession: false, resendMission: false };
      default:
        return { approveNotSameSession: false, resendMission: false }
    }

  }

  private setSystemStatus(data: TRANSACTION_INFO) {
    const { amrId, session, return_code, approveNotSameSession, qamsSerialNum } = data;
    this.info.qamsSerialNum = qamsSerialNum ?? this.info.qamsSerialNum
    this.info.amrId = amrId ?? this.info.amrId;
    this.info.session = session ?? this.info.session;
    this.info.return_code = return_code ?? this.info.return_code
    this.info.approveNotSameSession = approveNotSameSession ?? this.info.approveNotSameSession
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
