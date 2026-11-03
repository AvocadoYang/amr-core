import { MAC } from '../configs'
import * as ROS from '../ros'
import * as net from 'net';
import { randomUUID } from 'crypto';
import { BehaviorSubject, distinctUntilChanged, EMPTY, filter, interval, mapTo, merge, Subject, switchMap, switchMapTo, take, tap } from "rxjs";
import { CustomerError, ValidationError } from "~/errorHandler/error";
import { isConnected, Output, ros_bridge_connected } from '~/actions/networkManager/output';
import { registerReturnCode, ReturnCode } from '~/mq/type/returnCode';
import { AMR_STATUS, CONNECT_STATUS, MISSION_STATUS } from '~/types/status';
import { errorLogger, infoLogger, warnLogger } from '~/logger/logger';
import { RBClient } from '~/mq';
import { sendRegisterRequest } from '~/mq/transactionsWrapper';
import { CMD_ID } from '~/mq/type/cmdId';
import { HANDSHAKE_EX } from '~/mq/type/type';
import { REGISTER_RES } from '~/mq/type/res';



class NetWorkManager {

  public server: net.Server
  private amrId: string = '';
  private output$: Subject<Output>;
  private reconnectCount$: BehaviorSubject<number> = new BehaviorSubject(0);
  private connectingInProgress = false;
  // the attempt in flight - its register wait and the retry timer after a failure - so a
  // RabbitMQ reconnect can drop them and register again on the new connection right away
  private attemptGen = 0;
  private pendingWait: { cancel: () => void } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastForcedReconnect = 0;
  /** last failed attempt to log in to QAMS - shown on the diagnostics page */
  public lastError: { message: string; at: number } = { message: "", at: 0 };

  constructor(
    private rb: RBClient,
    private amrStatus: AMR_STATUS,
    private missionStatus: MISSION_STATUS,
    private connectStatus: CONNECT_STATUS
  ) {
    this.output$ = new Subject();
    this.rosConnect();
  }



  /** Entry point for a fresh QAMS (re)connection attempt. No-op if an attempt (including its internal retries) is already running, so callers can invoke it freely without spawning parallel retry loops. */
  public async fleetConnect() {
    if (this.connectingInProgress) return;
    this.connectingInProgress = true;
    await this.attemptConnect();
  }

  /**
   * RabbitMQ (re)connected. A register still waiting for its answer went out on the old
   * connection and is lost - send it again now instead of waiting for its timeout (after an HA
   * switchover this is ~8 s offline instead of ~17 s). No-op when no attempt is running: main
   * starts a fresh one through fleetConnect().
   */
  public retryNow() {
    if (!this.connectingInProgress) return;
    this.pendingWait?.cancel();
    this.pendingWait = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    infoLogger.info("RabbitMQ reconnected, register with QAMS again now", {
      title: "system",
      type: "QAMS",
    });
    void this.attemptConnect();
  }

  /**
   * A register timed out on a connection that still looks fine. With HA the VIP can move to the
   * other host without breaking this TCP connection (e.g. a NAT on the way keeps it), and the
   * BACKUP it still reaches does not answer - so open a new connection, which goes to whoever
   * holds the VIP now. At most once per 30 s: on a single-host site whose QAMS is just down
   * (restarting) it would otherwise reopen RabbitMQ every 10 s for nothing.
   */
  private reconnectRabbitAfterTimeout() {
    if (Date.now() - this.lastForcedReconnect < 30_000) return;
    if (this.rb.forceReconnect("register response timeout")) this.lastForcedReconnect = Date.now();
  }

  /**
   * Resolves with the first REGISTER response matching requestId, or rejects on timeout.
   * cancel() stops waiting without rejecting - a wait nobody awaits any more must be cancelled,
   * or its timeout rejection goes unhandled and Node exits the whole process.
   */
  private waitForRegisterResponse(requestId: string, timeoutMs = 5000): { response: Promise<REGISTER_RES>; cancel: () => void } {
    let cancel = () => {};
    const response = new Promise<REGISTER_RES>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new CustomerError("5557", "register response timeout"));
      }, timeoutMs);
      const sub = this.rb.onRegisterResTransaction((action) => {
        if (action.payload.cmd_id === CMD_ID.REGISTER && action.payload.id === requestId) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(action as REGISTER_RES);
        }
      });
      cancel = () => {
        clearTimeout(timer);
        sub.unsubscribe();
      };
    });
    return { response, cancel };
  }

  private async attemptConnect() {
    // a newer attempt (retryNow) supersedes this one: it must not log in or schedule retries
    const gen = ++this.attemptGen;
    this.retryTimer = null;
    try {

      const requestId = randomUUID();
      // listen before publishing so a fast answer is not missed
      const wait = this.waitForRegisterResponse(requestId);
      this.pendingWait = wait;
      const published = await this.rb.reqPublish(
        HANDSHAKE_EX,
        `qams.register.req.register.${MAC}`,
        sendRegisterRequest({
          serialNumber: MAC,
        }),
        { expiration: "3000" },
        requestId
      );
      if (!published) {
        // RabbitMQ is down (e.g. the network cable is out): nothing will answer this request
        wait.cancel();
        throw new CustomerError("5556", "failed to publish register request to QAMS");
      }

      const response = await wait.response;
      if (gen !== this.attemptGen) return;
      this.pendingWait = null;
      const { session, payload } = response;
      const { return_code, amrId, message, qamsSerialNum } = payload;

      if (registerReturnCode.includes(return_code) &&
        return_code !== ReturnCode.NOT_IN_SYSTEM_LOGIN_ERROR &&
        return_code !== ReturnCode.FORMAT_ERROR_LOGIN_ERROR
      ) {
        infoLogger.info(`connect to QAMS`, {
          title: "system",
          type: "QAMS 🤝",
          status: { message, return_code, session, amrId }
        });
        this.amrId = amrId;
        this.connectingInProgress = false;
        this.output$.next(isConnected({ isConnected: true, amrId, return_code, session, qamsSerialNum }));
      } else {
        this.output$.next(isConnected({ isConnected: false, amrId, return_code, session, qamsSerialNum }));
        throw new CustomerError(return_code, message);
      }
    } catch (error) {
      if (gen !== this.attemptGen) return;
      this.pendingWait = null;
      this.lastError = {
        message:
          error instanceof CustomerError
            ? `${error.statusCode} ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
        at: Date.now(),
      };
      if (error instanceof ValidationError) {
        errorLogger.error("can't connect with QAMS, retry after 5s..", {
          title: "system",
          type: "QAMS",
          status: error.msg,
        });
      } else if (error instanceof CustomerError) {
        if (error.statusCode == "5555") {
          errorLogger.error("can't connect with QAMS because of amr status is null, retry after 5s..", {
            title: "system",
            type: "QAMS",
            status: {
              return_code: error.statusCode,
              amrHasMission: this.amrStatus.amrHasMission ? this.amrStatus.amrHasMission : "null",
              currentId: this.amrStatus.currentId ? this.amrStatus.currentId : "null",
              poseAccurate: this.amrStatus.poseAccurate ? this.amrStatus.poseAccurate : "null",
              description: error.message
            },
          });
        } else {
          errorLogger.error("can't connect with QAMS, retry after 5s..", {
            title: "system",
            type: "QAMS",
            status: {
              return_code: error.statusCode,
              description: error.message
            },
          });
        }
      } else {
        errorLogger.error(`${error instanceof Error ? error.message : String(error)}, retry after 5s..`, {
          title: "system",
          type: "QAMS",
        });
      }
      if (error instanceof CustomerError && error.statusCode == "5557") this.reconnectRabbitAfterTimeout();
      this.retryTimer = setTimeout(async () => await this.attemptConnect(), 5000)
    }

  }

  public rosConnect() {
    ROS.init();
    ROS.connected$.subscribe(() => {
      this.reconnectCount$.next(this.reconnectCount$.value + 1);
    });


    this.reconnectCount$.pipe(filter((v) => v > 1)).subscribe((count) => {
      infoLogger.info(`ROS bridge has been reconnected for ${count} time`, {
        title: "system",
        type: "ros bridge",
      });
    });

    ROS.connected$
      .pipe(switchMapTo(ROS.pose$), take(1))
      .subscribe(({ x, y, yaw }) => {
        if (Math.abs(x) < 0.1 && Math.abs(y) < 0.1 && Math.abs(yaw)) {
          const pose = `(${x.toFixed(2)}, ${y.toFixed(2)}, ${yaw.toFixed(2)})`;
          errorLogger.error(
            `Connected to ROS and get pose ${pose}, which is too close to (0, 0) and possible wrong. Please make sure AMR have reasonable initial pose.`,
            {
              title: "system",
              type: "ros bridge",
            }
          );
        }
      });

    merge(
      ROS.connected$.pipe(mapTo(true)),
      ROS.connectionClosed$.pipe(mapTo(false))
    )
      .pipe(
        distinctUntilChanged(),
        tap((isConnected) => this.output$.next(ros_bridge_connected({ isConnected }))),
        switchMap((isConnected) => (isConnected ? EMPTY : interval(5000)))
      )
      .subscribe(() => {
        ROS.reconnect();
      });

  }

  public subscribe(cb: (action: Output) => void) {
    return this.output$.subscribe(cb);
  }

  public getAmrId() {
    return this.amrId;
  }

}

export default NetWorkManager
