import dotenv from "dotenv";
import config from './configs'
import { cleanEnv, str } from "envalid";
import { HeartbeatMonitor, MissionManager, MoveControl, NetWorkManager, Status, WsServer } from "./service";
import { RBClient } from "./mq";
import { IS_CONNECTED, isConnected, ROS_BRIDGE_CONNECTED } from "./actions/networkManager/output";
import { RB_IS_CONNECTED } from "./actions/rabbitmq/output";
import { AMR_HAS_MISSION, MISSION_INFO } from "./actions/mission/output";
import { ReturnCode } from "./mq/type/returnCode";
import { MapType } from "./types/map";
import axios from "axios";
import * as ROS from './ros'
import { connectWithQAMS, connectWithRosBridge as rabbit_connectWithRosBridge, sendAmrServiceIsConnected } from "./actions/rabbitmq/input";
import {
  connectWithRosBridge as heartbeat_connectWithRosBridge,
  connectWithQAMS as heartbeat_connectWithQAMS,
  connectWithRabbitMq as heart_connectWithRabbitMq
} from './actions/heartbeatMonitor/input'
import { AMR_SERVICE_ISCONNECTED, QAMS_DISCONNECTED, RECONNECT_QAMS } from "./actions/heartbeatMonitor/output";
import { AMR_STATUS, CONNECT_STATUS, MISSION_STATUS, TRANSACTION_INFO } from "./types/status";

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
    { amrHasMission: undefined, poseAccurate: undefined, currentId: undefined };
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

  constructor() {
    this.rb = new RBClient(this.info, this.consumedQueues);
    this.hb = new HeartbeatMonitor(this.info, this.connectStatus, this.rb, this.missionStatus)
    this.ws = new WsServer();
    this.netWorkManager = new NetWorkManager(this.amrStatus, this.missionStatus);
    this.ms = new MissionManager(this.rb, this.missionStatus);
    this.st = new Status(this.rb, this.info, this.connectStatus, this.map, this.amrStatus);
    this.mc = new MoveControl(this.rb, this.info);


    this.netWorkManager.subscribe(async (action) => {
      switch (action.type) {
        case IS_CONNECTED:
          try {
            const { isConnected, amrId, session, return_code, qamsSerialNum } = action;
            let approveNotSameSession = false;
            if (isConnected) {
              this.info.qamsSerialNum = qamsSerialNum;
              approveNotSameSession = this.registerProcess(action);
              this.setSystemStatus({ amrId, session, return_code, qamsSerialNum, approveNotSameSession })
              this.rb.send(connectWithQAMS({ isConnected }));
              this.hb.send(heartbeat_connectWithQAMS({ isConnected }))
              const { data } = await axios.get(`http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/test/map`);
              this.map = data;
            } else {
              this.setSystemStatus({ amrId, session, return_code, qamsSerialNum, approveNotSameSession: false })
            }
            this.connectStatus.qams_isConnect = isConnected;
          } catch (err) {
            this.hb.send(heartbeat_connectWithQAMS({ isConnected: false }))
          }
          break;
        case ROS_BRIDGE_CONNECTED:
          try {
            const { isConnected } = action;
            if (!isConnected) {
              this.amrStatus = { amrHasMission: undefined, poseAccurate: undefined, currentId: undefined };
            }
            this.rb.send(rabbit_connectWithRosBridge({ isConnected }));
            this.hb.send(heartbeat_connectWithRosBridge({ isConnected }))
          } catch {
            this.hb.send(heartbeat_connectWithRosBridge({ isConnected: false }))
          }
          break;
        default:
          break;
      }
    });

    this.rb.subscribe((action) => {
      switch (action.type) {
        case RB_IS_CONNECTED:
          const { isConnected } = action;
          this.hb.send(heart_connectWithRabbitMq({ isConnected }))
          break;
        default:
          break;
      }
    });




    this.hb.subscribe(async (action) => {
      switch (action.type) {
        case QAMS_DISCONNECTED:
          this.rb.send(connectWithQAMS({ isConnected: action.isConnected }))
          break;
        case RECONNECT_QAMS:
          await this.netWorkManager.fleetConnect();
          break;
        case AMR_SERVICE_ISCONNECTED:
          this.rb.send(sendAmrServiceIsConnected({ isConnected: action.isConnected }));
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
      case ReturnCode.MISSION_TIMEOUT_LOGIN_SUCCESS:
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS:
        ROS.cancelCarStatusAnyway(this.missionStatus.lastSendGoalId);
        this.ms.resetMissionStatus();
        return false;
      case ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_AMR_SERVICE:
        this.ms.resetMissionStatus();
        return false;
      /** */
      case ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS:
        return true;
      /**  */
      default:
        break;
    }

    return false

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

}

new AmrCore();


