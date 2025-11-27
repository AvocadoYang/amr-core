import config from '../configs'
import { cleanEnv, str } from "envalid";
import dotenv from "dotenv";
import * as ROS from '../ros'
import { BehaviorSubject, distinctUntilChanged, EMPTY, filter, interval, mapTo, merge, Subject, switchMap, switchMapTo, take, tap, timeout } from "rxjs";
import axios from "axios";
import { array, object, string, ValidationError, ValidationError as YupValidationError } from "yup";
import { CustomerError } from "~/errorHandler/error";
import { SysLoggerNormalError, SysLoggerNormal, SysLoggerNormalWarning } from "~/logger/systemLogger";
import { bindingTable } from '~/mq/bindingTable';
import { isConnected, Output } from '~/actions/networkManager/output';
import { sendCancelMission, setMissionInfo } from '~/actions/mission/output';
import { registerReturnCode, ReturnCode } from '~/mq/type/returnCode';


class NetWorkManager {

  public amrIsRegistered: boolean = false;

  private ros_bridge_error_log = true
  private ros_bridge_close_log = true
  private fleet_connect_log = true
  private amrId: string = '';
  private output$: Subject<Output>;
  private reconnectCount$: BehaviorSubject<number> = new BehaviorSubject(0);

  private lastSendGoalId: string = "";
  private lastTransactionId: string = "";
  private lastMissionType: string = "";

  constructor() {
    this.output$ = new Subject();
  }

  public async fleetConnect() {
    const schema = object({
      applicant: string().required(),
      amrId: string(),
      return_code: string().required(),
      occupied: array(string()).required(),
      permitted: array(string()).required(),
    })
    while (true) {
      try {
        const { data } = await axios.post(
          `http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/amr/establish-connection`, {
          serialNumber: config.MAC,
          lastSendGoalId: this.lastSendGoalId,
          lastTransaction: this.lastTransactionId,
          lastMissionType: this.lastMissionType,
          amrIsRegistered: this.amrIsRegistered,
          timeout: 5000
        });

        const { return_code, amrId, occupied, permitted } = await schema.validate(data).catch((err) => {
          throw new ValidationError(err, (err as YupValidationError).message)
        });


        if (registerReturnCode.includes(return_code as ReturnCode)) {
          SysLoggerNormal.info(`connect to QAMS ${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}`, {
            type: "QAMS",
          });
          this.amrId = amrId;
          this.fleet_connect_log = true;
          this.output$.next(isConnected({ isConnected: true, amrId, return_code, trafficStatus: { occupied, permitted } }));
          break;
        } else {
          throw new CustomerError(return_code, "custom error");
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
              SysLoggerNormalError.error("can't connect with QAMS, retry after 5s..", {
                type: "QAMS",
                status: { return_code: error.statusCode, description: error.message },
              });
              break;
            default:
              SysLoggerNormalError.error(`${error.message}, retry after 5s..`, {
                type: "QAMS",
              });
              break;
          }
          this.fleet_connect_log = false;
        }
        // this.output$.next(isConnected({ isConnected: false }));
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }

  public rosConnect() {
    ROS.init();
    ROS.connected$.subscribe(() => {
      SysLoggerNormal.info(`connect with ROS bridge`, {
        type: "ros bridge",
      });
      this.ros_bridge_error_log = true;
      this.ros_bridge_close_log = true;
      this.reconnectCount$.next(this.reconnectCount$.value + 1);
      // ROS.testTop();
    });


    ROS.connectionError$.subscribe((error: Error) => {
      if (this.ros_bridge_error_log) {
        SysLoggerNormalWarning.warn("ROS bridge connect error", {
          type: "ros bridge",
          status: error.message,
        });
        this.ros_bridge_error_log = false;
      }

    });

    ROS.connectionClosed$.subscribe(() => {
      if (this.ros_bridge_close_log) {
        SysLoggerNormalWarning.warn("ROS bridge connection closed", {
          type: "ros bridge",
        });
        this.ros_bridge_close_log = false;
      }
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

  public updateMissionStatus(action: { missionType: string, lastSendGoalId: string, lastTransactionId: string }) {
    this.lastMissionType = action.missionType;
    this.lastSendGoalId = action.lastSendGoalId;
    this.lastTransactionId = action.lastTransactionId;
  }
}

export default NetWorkManager
