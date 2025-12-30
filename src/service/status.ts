import { RBClient } from '~/mq';
import * as ROS from '../ros'
import config from "../configs";
import { sendBaseResponse, sendCargoVerity, sendCurrentId, sendErrorInfo, sendIOInfo, sendIsRegistered, sendPose, sendPoseAccurate } from '~/mq/transactionsWrapper';
import { CMD_ID, fakeIoInfo } from '~/mq/type/cmdId';
import { CONTROL_EX, IO_EX, RES_EX } from '~/mq/type/type';
import { isDifferentPose, formatPose, SimplePose } from '~/helpers';
import logger from '~/logger';
import { ReturnCode } from '~/mq/type/returnCode';
import { interval, Subject, throttleTime } from 'rxjs';
import { MapType } from '~/types/map';
import axios from 'axios';
import { Output, setIsRegistered } from '~/actions/status/output';
import { CONNECT_STATUS, TRANSACTION_INFO } from '~/types/status';


class Status {
    private lastPose: SimplePose = { x: 0, y: 0, yaw: 0 };
    private output$: Subject<Output> = new Subject();
    constructor(
        private rb: RBClient,
        private info: TRANSACTION_INFO,
        private connectStatus: CONNECT_STATUS,
        private map: MapType,
        private amrStatus: { amrHasMission: boolean, amrIsRegistered: boolean }
    ) {

        this.rb.onControlTransaction(async (action) => {
            const { payload, serialNum } = action;
            const { id, cmd_id } = payload;
            switch (payload.cmd_id) {
                case CMD_ID.UPDATE_MAP:
                    const { isUpdate } = payload
                    ROS.updatePosition({ data: isUpdate });
                    this.rb.resPublish(
                        RES_EX,
                        `qams.${config.MAC}.res.updateMap`,
                        sendBaseResponse({ cmd_id, id, amrId: this.info.amrId, return_code: ReturnCode.SUCCESS }),
                        { expiration: "2000" }
                    );
                    const { data } = await axios.get(`http://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/api/test/map`);
                    this.map = data;
                    break;
                case CMD_ID.EMERGENCY_STOP:
                    ROS.pause(payload.payload);
                    this.rb.resPublish(RES_EX, `qams.${config.MAC}.res.emergencyStop`,
                        sendBaseResponse({ cmd_id, id, amrId: this.info.amrId, return_code: ReturnCode.SUCCESS }),
                        { expiration: "2000" }
                    )
                    break;
                case CMD_ID.FORCE_RESET:
                    ROS.forceResetButton();
                    this.rb.resPublish(RES_EX, `qams.${config.MAC}.res.forceReset`,
                        sendBaseResponse({ cmd_id, id, amrId: this.info.amrId, return_code: ReturnCode.SUCCESS }),
                        { expiration: "2000" }
                    )
                    break;
                case CMD_ID.HAS_CARGO:
                    ROS.sendHasCargo(payload.hasCargo);
                    break;
                default:
                    break;
            }
        });

        /** ROS subscribe */

        ROS.pose$.subscribe((pose) => {
            if (!this.connectStatus.qams_isConnect) return;
            if (isDifferentPose(pose, this.lastPose, 0.01, 0.01)) {
                logger.silly(`emit socket 'pose' ${formatPose(pose)}`);
            }
            const machineOffset = {
                x: -Math.sin((pose.yaw * Math.PI) / 180) * 0,
                y: -Math.cos((pose.yaw * Math.PI) / 180) * 0,
            };
            const Pose = { x: pose.x + machineOffset.x, y: pose.y + machineOffset.y, yaw: pose.yaw }
            this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.pose`, sendPose(Pose), {
                expiration: "3000"
            })
            this.lastPose = pose;
        });

        ROS.getAmrError$.subscribe((msg: { data: string }) => {
            if (!this.connectStatus.qams_isConnect) return;
            const jMsg = JSON.parse(msg.data) as {
                warning_msg: string[];
                warning_id: string[];
            };
            this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.errorInfo`, sendErrorInfo(jMsg), { expiration: "3000" });
        });

        ROS.getIOInfo$.subscribe((data) => {
            if (!this.connectStatus.qams_isConnect) return;
            this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.ioInfo`, sendIOInfo(data), {
                expiration: "2000"
            })
        });

        ROS.currentId$.pipe(throttleTime(2000)).subscribe((currentId) => {
            if (!this.connectStatus.qams_isConnect) return;
            this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.currentId`, sendCurrentId(currentId), {
                expiration: "2000"
            })
        });

        ROS.currentPoseAccurate$.subscribe((msg) => {
            if (!this.connectStatus.qams_isConnect) return;
            this.rb.reqPublish(IO_EX, `amr.io.${config}.poseAccurate`, sendPoseAccurate(msg), { expiration: "2000" })
        });

        ROS.is_registered.subscribe(msg => {
            if (!this.connectStatus.qams_isConnect) return;
            this.rb.reqPublish(IO_EX, `amr.io.${config}.isRegistered`, sendIsRegistered(msg), { expiration: "2000" });
            this.amrStatus.amrIsRegistered = msg;
        });

        ROS.has_mission.subscribe(msg => {
            if (!this.connectStatus.qams_isConnect) return;
            console.log(msg)
        })

        ROS.getVerityCargo$.subscribe((msg) => {
            this.rb.reqPublish(CONTROL_EX, `qams.${config.MAC}.handshake.cargoVerity`, sendCargoVerity(msg))
        });



        this.mock();
    }

    public subscribe(cb: (action: Output) => void) {
        return this.output$.subscribe(cb);
    }


    private mock() {
        //        interval(200).subscribe(() =>{
        //   this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.pose`,  sendPose({ x: 1, y:2, yaw: 3}), {
        //     expiration: "3000"
        //   })
        // })

        //   interval(4000).subscribe(() => {
        //     const jMsg = {
        //         warning_msg: ["1", "2"],
        //         warning_id: ["3", "4"]
        //     }
        //     this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.errorInfo`, sendErrorInfo(jMsg));
        // })

        //     interval(100).subscribe(() =>{
        //     this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.ioInfo`, sendIOInfo(JSON.stringify(fakeIoInfo)), {
        //         expiration: "1000"
        //     });
        // })

        // interval(2000).subscribe(() => {
        //     this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.currentId`, sendCurrentId("100"), {
        //         expiration: "2000"
        //     })
        // })

        // interval(200).subscribe(() => {
        //     this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.isAccurate`, sendPoseAccurate(true))
        // })

        // interval(3000).subscribe(() => {
        //     const data = {
        //         c_gen: "123",
        //         c_type: "test",
        //         result: true,
        //         status: "hi"
        //     }
        //     this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.handshake.cargoVerity`, sendCargoVerity(JSON.stringify(data)));
        // })

    }

}


export default Status;