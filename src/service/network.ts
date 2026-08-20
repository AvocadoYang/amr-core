import { MAC } from '../configs'
import * as ROS from '../ros'
import * as net from 'net';
import { randomUUID } from 'crypto';
import { BehaviorSubject, distinctUntilChanged, EMPTY, filter, interval, mapTo, merge, Subject, switchMap, switchMapTo, take, tap } from "rxjs";
import { CustomerError, ValidationError } from "~/errorHandler/error";
import { isConnected, Output, ros_bridge_connected } from '~/actions/networkManager/output';
import { registerReturnCode, ReturnCode } from '~/mq/type/returnCode';
import { AMR_STATUS, MISSION_STATUS } from '~/types/status';
import { errorLogger, infoLogger, warnLogger } from '~/logger/logger';
import { RBClient } from '~/mq';
import { sendRegisterRequest } from '~/mq/transactionsWrapper';
import { CMD_ID } from '~/mq/type/cmdId';
import { CONTROL_EX } from '~/mq/type/type';
import { REGISTER_RES } from '~/mq/type/res';



class NetWorkManager {

  public server: net.Server
  private fleet_connect_log = true
  private amrId: string = '';
  private output$: Subject<Output>;
  private reconnectCount$: BehaviorSubject<number> = new BehaviorSubject(0);
  private connectingInProgress = false;

  constructor(
    private rb: RBClient,
    private amrStatus: AMR_STATUS,
    private missionStatus: MISSION_STATUS
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

  /** Resolves with the first REGISTER response matching requestId, or rejects on timeout. */
  private waitForRegisterResponse(requestId: string, timeoutMs = 5000): Promise<REGISTER_RES> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.unsubscribe();
        reject(new CustomerError("5557", "register response timeout"));
      }, timeoutMs);
      const sub = this.rb.onResTransaction((action) => {
        if (action.payload.cmd_id === CMD_ID.REGISTER && action.payload.id === requestId) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(action as REGISTER_RES);
        }
      });
    });
  }

  private async attemptConnect() {
    try {
      if (this.amrStatus.currentId == undefined || this.amrStatus.poseAccurate == undefined) {
        throw new CustomerError("5555", "amr status is null");
      }

      if (this.amrStatus.poseAccurate) {
        warnLogger.warn(`AMR localization warning`, {
          title: 'system',
          type: 'amr status'
        })
        throw new CustomerError("5554", "amr status is warning");
      }

      const requestId = randomUUID();
      const responsePromise = this.waitForRegisterResponse(requestId);
      const published = await this.rb.reqPublish(
        CONTROL_EX,
        `qams.register.req.${MAC}`,
        sendRegisterRequest({
          serialNumber: MAC,
          lastSendGoalId: this.missionStatus.lastSendGoalId,
          amrHasMission: this.amrStatus.amrHasMission,
        }),
        { expiration: "3000" },
        requestId
      );
      if (!published) {
        throw new CustomerError("5556", "failed to publish register request to QAMS");
      }

      const response = await responsePromise;
      const { session, payload } = response;
      const { return_code, amrId, message, qamsSerialNum } = payload;

      if (registerReturnCode.includes(return_code) &&
        return_code !== ReturnCode.NOT_IN_SYSTEM_LOGIN_ERROR &&
        return_code !== ReturnCode.FORMAT_ERROR_LOGIN_ERROR &&
        return_code !== ReturnCode.RABBIT_CONNECT_ERROR_LOGIN_ERROR
      ) {
        infoLogger.info(`connect to QAMS`, {
          title: "system",
          type: "QAMS 🤝",
          status: { message, return_code, session, amrId }
        });
        this.amrId = amrId;
        this.fleet_connect_log = true;
        this.connectingInProgress = false;
        this.output$.next(isConnected({ isConnected: true, amrId, return_code, session, qamsSerialNum }));
      } else {
        this.output$.next(isConnected({ isConnected: false, amrId, return_code, session, qamsSerialNum }));
        throw new CustomerError(return_code, message);
      }
    } catch (error) {
      if (this.fleet_connect_log) {
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
        this.fleet_connect_log = false;
      }
      setTimeout(async () => await this.attemptConnect(), 5000)
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
