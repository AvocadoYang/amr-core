import { BehaviorSubject, catchError, combineLatest, EMPTY, filter, from, interval, map, of, Subject, switchMap, tap, timer } from "rxjs";
import { CONNECT_WITH_AMR_SERVICE, CONNECT_WITH_QAMS, CONNECT_WITH_RABBIT_MQ, CONNECT_WITH_ROS_BRIDGE, connectWithQAMS, Input } from "~/actions/heartbeatMonitor/input";
import { Output, reconnectQAMS, sendQAMSDisconnected } from "~/actions/heartbeatMonitor/output";
import { ofType } from "~/helpers";
import * as net from 'net';
import { SysLoggerNormal } from "~/logger/systemLogger";
import { TCLoggerNormalWarning } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { HEARTBEAT_EX } from "~/mq/type/type";
import config from '../configs'
import { sendHeartBeatResponse } from "~/mq/transactionsWrapper";
import { ReturnCode } from "~/mq/type/returnCode";
import { CONNECT_STATUS, TRANSACTION_INFO } from "~/types/status";
import { number, object, ValidationError } from "yup";

export default class HeartbeatMonitor {
    private qamsLastHeartbeatTime: number = 0;
    private amrServiceLastHeartbeatTime: number = 0;
    private amrServiceHeartbeatCount = 0;

    private qams_connect$ = new BehaviorSubject<boolean>(false);
    private ros_bridge_connect$ = new BehaviorSubject<boolean>(false);
    private amr_service_connect$ = new BehaviorSubject<boolean>(false);
    private rabbit_connect$ = new BehaviorSubject<boolean>(false);

    private qams_lostCount: number = 0;

    public tcp_server: net.Server;
    private socket: net.Socket = null;


    public input$: Subject<Input> = new Subject();
    private output$: Subject<Output> = new Subject();
    constructor(
        private info: TRANSACTION_INFO,
        private connectStatus: CONNECT_STATUS,
        private rb: RBClient,
    ) {
        this.rb.onHeartbeat((action) => {
            const { payload } = action;
            const { heartbeat, id } = payload;
            this.qamsLastHeartbeatTime = Date.now();
            let resHeartbeat = heartbeat + 1 > 9999 ? 0 : heartbeat + 1;

            this.rb.resPublish(HEARTBEAT_EX, `qams.heartbeat.pong.${config.MAC}`,
                sendHeartBeatResponse({
                    id,
                    heartbeat: resHeartbeat,
                    return_code: ReturnCode.SUCCESS,
                    amrId: this.info.amrId
                }), { expiration: "2000" }
            )
        });

        this.input$.pipe(
            ofType(CONNECT_WITH_QAMS),
            switchMap(({ isConnected }) => {
                if (isConnected) {
                    SysLoggerNormal.info(`connect with QAMS, start heartbeat detection`, {
                        type: "heartbeat",
                    });
                    return timer(5000, 5000).pipe(
                        tap(() => {
                            const now = Date.now();
                            // console.log("time sub:  ", now - this.qamsLastHeartbeatTime)
                            if (now - this.qamsLastHeartbeatTime > 4000) {
                                this.qams_lostCount = this.qams_lostCount + 1;
                                if (this.qams_lostCount < 2) {
                                    TCLoggerNormalWarning.warn(`heartbeat delay, retry`, {
                                        group: "transaction",
                                        type: "heartbeat",
                                    });
                                }
                            } else {
                                this.qams_lostCount = 0;
                            }

                            if (this.qams_lostCount >= 2) {
                                TCLoggerNormalWarning.warn(`heartbeat timeout, disconnect`, {
                                    group: "transaction",
                                    type: "heartbeat",
                                });
                                this.output$.next(sendQAMSDisconnected({ isConnected: false }))
                                this.input$.next(connectWithQAMS({ isConnected: false }));
                            }
                        })
                    );
                } else {
                    this.connectStatus.qams_isConnect = false;
                    return EMPTY;
                }
            })

        ).subscribe();

        combineLatest([
            this.qams_connect$,
            this.ros_bridge_connect$,
            this.rabbit_connect$,
            this.amr_service_connect$
        ]).pipe(filter(([qamsConnect, rosbridgeConnect, rabbitConnect, amrServiceConnect]) => {
            SysLoggerNormal.info("service connect status", {
                type: "connect status",
                status: {
                    qamsConnect: qamsConnect ? "✅" : "❌",
                    rosbridgeConnect: rosbridgeConnect ? "✅" : "❌",
                    rabbitConnect: rabbitConnect ? "✅" : "❌",
                    amrServiceConnect: amrServiceConnect ? "✅" : "❌"
                }
            });
            this.setServiceConnectStatus({ qamsConnect, rosbridgeConnect, rabbitConnect, amrServiceConnect })
            return (
                qamsConnect == false &&
                rosbridgeConnect == true &&
                rabbitConnect == true
            )
        }),
            switchMap(() => {
                return from(this.retryConnectQAMSWithDelay(1500)).pipe(
                    catchError((err) => {
                        TCLoggerNormalWarning.warn(`reconnect failed: ${err}`);
                        return of();
                    })
                );
            })
        ).subscribe();

        this.input$.subscribe((action) => {
            const { isConnected } = action;
            switch (action.type) {
                case CONNECT_WITH_QAMS:
                    this.qams_connect$.next(isConnected);

                    break;
                case CONNECT_WITH_AMR_SERVICE:
                    this.amr_service_connect$.next(isConnected);

                    break;
                case CONNECT_WITH_ROS_BRIDGE:
                    this.ros_bridge_connect$.next(isConnected);

                    break
                case CONNECT_WITH_RABBIT_MQ:
                    this.rabbit_connect$.next(isConnected)

                    break;
                default:
                    break;
            }
        });

        this.createAmrServiceFn();
    }

    private async retryConnectQAMSWithDelay(delayMs: number) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        this.output$.next(reconnectQAMS())
    }

    private createAmrServiceFn() {
        this.tcp_server = net.createServer((socket) => {

            /**
              * {
              *  timestamp: string,
              *  heartbeat_count: 0-9999
              * }
              */
            this.socket = socket;

            socket.on("data", async (chunk) => {
                const schema = object({
                    timestamp: number().required(),
                    heartbeat_count: number().required()
                });
                try {
                    const msg = JSON.parse(chunk.toString());
                    const { heartbeat_count } = await schema.validate(msg).catch((err) => {
                        throw new ValidationError(err, (err as ValidationError).message)
                    });
                    const resCount = Number(heartbeat_count) + 1 > 9999 ? 0 : Number(heartbeat_count) + 1;
                    this.amrServiceHeartbeatCount = resCount;
                    this.socket.write(
                        JSON.stringify({
                            timestamp: (Date.now()).toString(),
                            heartbeat_count: this.amrServiceHeartbeatCount
                        })
                    )

                } catch (err) {
                    console.log(err);
                }
            })
        });

        this.tcp_server.listen(8532, () => {
            SysLoggerNormal.info(`tcp server is running on ${8532}`, {
                type: "tcp service"
            })
        })

        // heartbeat launch
        this.amr_service_connect$.pipe(
            switchMap((isConnected) => {
                if (isConnected) {
                    return interval(1000)
                        .pipe(tap(() => {
                            if (!this.socket) return;
                            const timestamp = Date.now();
                            this.amrServiceLastHeartbeatTime = timestamp;
                            this.socket.write(
                                JSON.stringify({
                                    timestamp: timestamp.toString(),
                                    heartbeat_count: this.amrServiceHeartbeatCount
                                })
                            )
                        }))
                }
                return EMPTY;
            })
        ).subscribe();

        // heartbeat watch dog
        this.amr_service_connect$.pipe(
            tap((isConnected) => { if (isConnected) this.amrServiceLastHeartbeatTime = Date.now() }),
            switchMap((isConnected) => {
                if (isConnected) {
                    return timer(2000, 3000).pipe(
                        tap(() => {
                            const timestamp = Date.now();
                            if (timestamp - this.amrServiceLastHeartbeatTime > 2500) {
                                this.amr_service_connect$.next(false);
                                this.socket.destroy();
                                this.socket = null;
                                this.amrServiceHeartbeatCount = 0;
                            }
                        })
                    )
                };
                return of()
            })
        ).subscribe();


    }

    private setServiceConnectStatus(status:
        { qamsConnect: boolean, rosbridgeConnect: boolean, rabbitConnect: boolean, amrServiceConnect: boolean }
    ) {
        this.connectStatus.qams_isConnect = status.qamsConnect;
        this.connectStatus.rosbridge_isConnect = status.rosbridgeConnect;
        this.connectStatus.rabbitMQ_isConnect = status.rabbitConnect;
        this.connectStatus.amr_service_isConnect = status.amrServiceConnect;
    }

    public send(action: Input) {
        this.input$.next(action)
    }
    public subscribe(cb: (action: Output) => void) {
        return this.output$.subscribe(cb);
    }

} 