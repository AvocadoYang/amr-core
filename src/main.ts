import dotenv from "dotenv";
import config from './configs'
import { cleanEnv, str } from "envalid";
import { HeartbeatMonitor, MissionManager, MoveControl, NetWorkManager, Status, WsServer } from "./service";
import { RBClient } from "./mq";
import { BehaviorSubject, catchError, from, interval, map, timer, of, Subject, switchMap, tap, EMPTY, combineLatest, filter } from "rxjs";
import { IS_CONNECTED, isConnected, ROS_BRIDGE_CONNECTED } from "./actions/networkManager/output";
import { TCLoggerNormalWarning } from "./logger/trafficCenterLogger";
import { RB_IS_CONNECTED } from "./actions/rabbitmq/output";
import { sendHeartBeatResponse } from "./mq/transactionsWrapper";
import { AMR_HAS_MISSION, CANCEL_MISSION, END_MISSION, MISSION_INFO, START_MISSION, TARGET_LOC } from "./actions/mission/output";
import { HEARTBEAT_EX } from "./mq/type/type";
import { ReturnCode } from "./mq/type/returnCode";
import { MapType } from "./types/map";
import axios from "axios";
import * as ROS from './ros'
import { SysLoggerNormal, SysLoggerNormalWarning } from "./logger/systemLogger";
import { connectWithQAMS, connectWithRosBridge as rabbit_connectWithRosBridge } from "./actions/rabbitmq/input";
import {
  connectWithRosBridge as heartbeat_connectWithRosBridge,
  connectWithQAMS as heartbeat_connectWithQAMS,
  connectWithRabbitMq as heart_connectWithRabbitMq
} from './actions/heartbeatMonitor/input'
import { QAMS_DISCONNECTED, RECONNECT_QAMS } from "./actions/heartbeatMonitor/output";
import { AMR_STATUS, CONNECT_STATUS, TRANSACTION_INFO } from "./types/status";

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
  private amrStatus: AMR_STATUS =
    { amrHasMission: false, amrIsRegistered: false, rosbridgeIsConnected: false };
  private info: TRANSACTION_INFO =
    { amrId: "", qamsSerialNum: "", session: "", return_code: "" }
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
    this.hb = new HeartbeatMonitor(this.info, this.connectStatus, this.rb)
    this.ws = new WsServer();
    this.netWorkManager = new NetWorkManager(this.amrStatus);
    this.ms = new MissionManager(this.rb, this.info, this.connectStatus, this.amrStatus);
    this.st = new Status(this.rb, this.info, this.connectStatus, this.map, this.amrStatus);
    this.mc = new MoveControl(this.rb, this.ws, this.info, this.map);


    this.netWorkManager.subscribe(async (action) => {
      switch (action.type) {
        case IS_CONNECTED:
          try {
            const { isConnected, amrId, session, return_code, qamsSerialNum } = action;
            this.setStatus({ amrId, session, return_code, qamsSerialNum })
            if (isConnected) {
              this.info.qamsSerialNum = qamsSerialNum;
              this.registerProcess(action);
              this.rb.send(connectWithQAMS({ isConnected }));
              this.hb.send(heartbeat_connectWithQAMS({ isConnected }))
              const { data } = await axios.get(`http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/test/map`);
              this.map = data;
            }
            this.connectStatus.qams_isConnect = isConnected;
          } catch (err) {
            this.hb.send(heartbeat_connectWithQAMS({ isConnected: false }))
          }
          break;
        case ROS_BRIDGE_CONNECTED:
          try {
            const { isConnected } = action;
            this.amrStatus.rosbridgeIsConnected = isConnected
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


    this.hb.subscribe(async (action) => {
      switch (action.type) {
        case QAMS_DISCONNECTED:
          const { isConnected } = action;
          this.rb.send(connectWithQAMS({ isConnected }))
          break;
        case RECONNECT_QAMS:
          await this.netWorkManager.fleetConnect();
          break;
        default:
          break;
      }
    })

  }

  public async init() {
    await this.rb.connect();
    this.netWorkManager.rosConnect();
  }





  private registerProcess(action: ReturnType<typeof isConnected>) {
    const { return_code } = action;
    switch (return_code) {
      case ReturnCode.SUCCESS:
        break;
      /** */
      case ReturnCode.NORMAL_REGISTER:
        this.ms.updateStatue({ missionType: "", lastSendGoadId: "", targetLoc: "", lastTransactionId: "" });
        if (this.amrStatus.amrHasMission) ROS.cancelCarStatusAnyway("#")
        break;
      /** */
      case ReturnCode.REGISTER_SUCCESS_MISSION_NOT_EQUAL:
        if (this.ms.lastTransactionId) {
          ROS.cancelCarStatusAnyway(this.ms.lastSendGoalId);
          this.ms.updateStatue({ missionType: "", lastSendGoadId: "", targetLoc: "", lastTransactionId: "" });
        };
        break;
      /** */
      case ReturnCode.REGISTER_SUCCESS_AMR_NOT_REGISTER:
        break;
      /**  */
      default:
        break;
    }

  }

  private setStatus(data: TRANSACTION_INFO) {
    const { amrId, session, return_code } = data;
    this.info.amrId = amrId;
    this.info.session = session;
    this.info.return_code = return_code
  }


}


const amrCore = new AmrCore();
(async () => {
  amrCore.init();
})()


