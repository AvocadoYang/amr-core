import { group } from 'console';
import { from, fromEventPattern, Observable, Subject } from 'rxjs';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { SysLoggerNormal } from '~/logger/systemLogger';
import { TCLoggerNormal } from '~/logger/trafficCenterLogger';

class WsServer {
    public isAwayObs: Observable<{ locationId: string, ack: (...args: any[]) => void }>;
    public isArriveObs: Observable<{ locationId: string, ack: (...args: any[]) => void }>;
    public output$: Subject<boolean> = new Subject();
    constructor() {
        const io = new SocketIOServer();

        io.on("connection", (socket) => {
            TCLoggerNormal.info("connect with ROS fleet", {
                group: "ws",
                type: "connect"
            })
            this.onConnection(socket)
        });

        io.on("disconnect", () => {
            this.output$.next(false)
        });


        io.listen(8111);

        SysLoggerNormal.info("create ws server on port 8111...", {
            type: "ws"
        });
    };

    public onConnection(socket: Socket,) {

        this.isArriveObs = fromEventPattern(
            (next) => {
                const handler = (msg, ack) => next({ ...JSON.parse(msg), ack });
                socket.on("is_arrive", handler);
                return handler;
            },
            (handler) => {
                socket.off("is_arrive", handler);
            }
        );

        this.isAwayObs = fromEventPattern(
            (next) => {
                const handler = (msg, ack) => next({ ...JSON.parse(msg), ack });
                socket.on("is_away", handler);
                return handler;
            },
            (handler) => {
                socket.off("is_away", handler);
            }
        );
        this.output$.next(true)


    }

    public subscribe(cb: (action: boolean) => void) {
        this.output$.subscribe(cb)
    }
}

export default WsServer;