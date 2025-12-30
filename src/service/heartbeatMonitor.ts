import { BehaviorSubject, catchError, combineLatest, EMPTY, filter, from, map, of, Subject, switchMap, tap, timer } from "rxjs";
import { CONNECT_WITH_AMR_SERVICE, CONNECT_WITH_QAMS, CONNECT_WITH_RABBIT_MQ, CONNECT_WITH_ROS_BRIDGE, connectWithQAMS, Input } from "~/actions/heartbeatMonitor/input";
import { Output, reconnectQAMS, sendQAMSDisconnected } from "~/actions/heartbeatMonitor/output";
import { ofType } from "~/helpers";
import { SysLoggerNormal } from "~/logger/systemLogger";
import { TCLoggerNormalWarning } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { HEARTBEAT_EX } from "~/mq/type/type";
import config from '../configs'
import { sendHeartBeatResponse } from "~/mq/transactionsWrapper";
import { ReturnCode } from "~/mq/type/returnCode";
import { CONNECT_STATUS, TRANSACTION_INFO } from "~/types/status";

export default class HeartbeatMonitor {
    private qamsLastHeartbeatTime: number = 0;
    private response: number = 0;

    private qams_connect$ = new BehaviorSubject<boolean>(false);
    private ros_bridge_connect$ = new BehaviorSubject<boolean>(false);
    private amr_service_connect$ = new BehaviorSubject<boolean>(false);
    private rabbit_connect$ = new BehaviorSubject<boolean>(false);

    private qams_lostCount: number = 0;


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
                                TCLoggerNormalWarning.warn(`heartbeat delay, retry`, {
                                    group: "transaction",
                                    type: "heartbeat",
                                });
                                this.qams_lostCount = this.qams_lostCount + 1;
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
            this.rabbit_connect$
        ]).pipe(filter(([qamsConnect, rosbridgeConnect, rabbitConnect]) => {
            SysLoggerNormal.info("service connect status", {
                type: "connect status",
                status: { qamsConnect, rosbridgeConnect, rabbitConnect }
            });
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
    }

    private async retryConnectQAMSWithDelay(delayMs: number) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        this.output$.next(reconnectQAMS())
    }

    public send(action: Input) {
        this.input$.next(action)
    }
    public subscribe(cb: (action: Output) => void) {
        return this.output$.subscribe(cb);
    }

} 