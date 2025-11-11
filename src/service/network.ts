import config from '../configs'
import { cleanEnv, str } from "envalid";
import dotenv from "dotenv";
import * as ROS from '../ros'
import { BehaviorSubject, distinctUntilChanged, EMPTY, filter, interval, mapTo, merge, switchMap, switchMapTo, take, tap, timeout } from "rxjs";
import axios from "axios";
import { object, string, ValidationError, ValidationError as YupValidationError } from "yup";
import { CustomerError } from "~/errorHandler/error";
import { SysLoggerNormalError, SysLoggerNormal, SysLoggerNormalWarning } from "~/logger/systemLogger";
import { bindingTable } from '~/mq/bindingTable';

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

class NetWorkManager {
    private ros_bridge_error_log = true
    private ros_bridge_close_log = true
    private fleet_connect_log = true
    private amrId: string = '';
    private reconnectCount$: BehaviorSubject<number> = new BehaviorSubject(0);
    constructor(){
        this.rosConnect();
    }

    public async fleetConnect(){
      const schema = object({
        applicant: string().required(),
        amrId: string().nullable(),
        return_code: string().required()
      })
      while(true){
        try{
          const { data } = await axios.post(
            `http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/amr/establish-connection`,{
              serialNumber: config.MAC,
              bindingTable,
              timeout: 5000
            });

            const { return_code, amrId } = await schema.validate(data).catch((err) =>{
                throw new ValidationError(err, (err as YupValidationError).message)
            });
            if(return_code === "0000"){
              SysLoggerNormal.info(`connect to fleet manager ${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}`,{
                type: "fleet manager",
              });
              this.amrId = amrId;
              this.fleet_connect_log = true;
              break;
            }else{
              throw new CustomerError(return_code, "custom error");
            }
        }catch(error){
          if(this.fleet_connect_log){
            switch(error.type){
              case "yup":
                SysLoggerNormalError.error("can't connect with fleet manager, retry after 5s..",{
                  group: "system",
                  type: "fleet manager",
                  status: error.msg,
                });
                break;
              case "custom":
                SysLoggerNormalError.error("can't connect with fleet manager, retry after 5s..",{
                  group: "system",
                  type: "fleet manager",
                  status: { return_code: error.statusCode, description: error.message},
                });
                break;
              default:
                SysLoggerNormalError.error("unknown error, retry after 5s..",{
                  group: "system",
                  type: "fleet manager",
                  status: error.message,
                });
                break;
            }
            this.fleet_connect_log = false;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
    }

    private rosConnect(){
        ROS.init();
        ROS.connected$.subscribe(() => {
            SysLoggerNormal.info(`connect with ROS bridge`, {
              type: "ros bridge",
            });
            this.ros_bridge_error_log = true;
            this.ros_bridge_close_log = true;
            this.reconnectCount$.next(this.reconnectCount$.value + 1);
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

    public getAmrId(){
      return this.amrId;
    }
}

export default NetWorkManager
