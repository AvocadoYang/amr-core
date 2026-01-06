import config from '../configs'
import * as ROS from '../ros'
import * as net from 'net';
import { BehaviorSubject, distinctUntilChanged, EMPTY, filter, interval, mapTo, merge, Subject, switchMap, switchMapTo, take, tap, timeout, timestamp } from "rxjs";
import axios from "axios";
import { number, object, string, ValidationError, ValidationError as YupValidationError } from "yup";
import { CustomerError } from "~/errorHandler/error";
import { SysLoggerNormalError, SysLoggerNormal, SysLoggerNormalWarning } from "~/logger/systemLogger";
import { isConnected, Output, ros_bridge_connected } from '~/actions/networkManager/output';
import { registerReturnCode, ReturnCode } from '~/mq/type/returnCode';
import { AMR_STATUS, MISSION_STATUS } from '~/types/status';



class NetWorkManager {

  public server: net.Server
  private fleet_connect_log = true
  private amrId: string = '';
  private output$: Subject<Output>;
  private reconnectCount$: BehaviorSubject<number> = new BehaviorSubject(0);

  constructor(
    private amrStatus: AMR_STATUS,
    private missionStatus: MISSION_STATUS
  ) {
    this.output$ = new Subject();
    this.rosConnect();
  }

  public async fleetConnect() {
    const schema = object({
      applicant: string().required(),
      amrId: string(),
      qamsSerialNum: string(),
      session: string(),
      return_code: string().required(),
      message: string().required(),
    })
    try {
      if (this.amrStatus.amrHasMission == undefined || this.amrStatus.currentId == undefined || this.amrStatus.poseAccurate == undefined) {
        throw new CustomerError("5555", "amr status is null");
      }
      const { data } = await axios.post(
        `http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/amr/establish-connection`, {
        serialNumber: config.MAC,
        lastSendGoalId: this.missionStatus.lastSendGoalId,
        amrHasMission: this.amrStatus.amrHasMission,
        timeout: 5000
      });


      const { return_code, amrId, message, session, qamsSerialNum } = await schema.validate(data).catch((err) => {
        throw new ValidationError(err, (err as YupValidationError).message)
      });


      if (registerReturnCode.includes(return_code as ReturnCode) && return_code !== ReturnCode.NOT_IN_SYSTEM_LOGIN_ERROR && return_code !== ReturnCode.FORMAT_ERROR_LOGIN_ERROR) {
        SysLoggerNormal.info(`connect to QAMS ${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}`, {
          type: "QAMS",
          status: { message, return_code, session, amrId }
        });
        this.amrId = amrId;
        this.fleet_connect_log = true;
        this.output$.next(isConnected({ isConnected: true, amrId, return_code, session, qamsSerialNum }));
      } else {
        this.output$.next(isConnected({ isConnected: false, amrId, return_code, session, qamsSerialNum }));
        throw new CustomerError(return_code, message);
      }
    } catch (error) {
      if (this.fleet_connect_log) {
        switch (error.type) {
          case "yup":
            SysLoggerNormalError.error("can't connect with QAMS, retry after 5s..", {
              type: "QAMS",
              status: error.msg,
            });
            break;
          case "custom":
            if (error.statusCode == "5555") {
              SysLoggerNormalError.error("can't connect with QAMS, retry after 5s..", {
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
              SysLoggerNormalError.error("can't connect with QAMS, retry after 5s..", {
                type: "QAMS",
                status: {
                  return_code: error.statusCode,
                  description: error.message
                },
              });
            }
            break;
          default:
            SysLoggerNormalError.error(`${error.message}, retry after 5s..`, {
              type: "QAMS",
            });
            break;
        }
        this.fleet_connect_log = false;
      }
      setTimeout(async () => await this.fleetConnect(), 3500)
    }

  }

  public rosConnect() {
    ROS.init();
    ROS.connected$.subscribe(() => {
      this.reconnectCount$.next(this.reconnectCount$.value + 1);
    });


    this.reconnectCount$.pipe(filter((v) => v > 1)).subscribe((count) => {
      SysLoggerNormal.info(`ROS bridge has been reconnected for ${count} time`, {
        type: "ros bridge",
      });
    });

    ROS.connected$
      .pipe(switchMapTo(ROS.pose$), take(1))
      .subscribe(({ x, y, yaw }) => {
        if (Math.abs(x) < 0.1 && Math.abs(y) < 0.1 && Math.abs(yaw)) {
          const pose = `(${x.toFixed(2)}, ${y.toFixed(2)}, ${yaw.toFixed(2)})`;
          SysLoggerNormalError.error(
            `Connected to ROS and get pose ${pose}, which is too close to (0, 0) and possible wrong. Please make sure AMR have reasonable initial pose.`,
            {
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
