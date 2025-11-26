import { group } from 'console';
import { from, fromEventPattern, Observable } from 'rxjs';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { SysLoggerNormal } from '~/logger/systemLogger';
import { TCLoggerNormal } from '~/logger/trafficCenterLogger';

class WsServer {
    public isAwayObs: Observable<{ locationId: string, ack: (...args: any[]) => void }>;
    public isArriveObs: Observable<{ locationId: string, ack: (...args: any[]) => void }>;
    constructor() {
        const io = new SocketIOServer();

        io.on("connection", (socket) => {
            TCLoggerNormal.info("connect with ROS fleet", {
                group: "ws",
                type: "connect"
            })
            this.onConnection(socket)
        })
        io.listen(8111);

        SysLoggerNormal.info("create ws server on port 8111...", {
            type: "ws"
        });
    };

    public onConnection(socket: Socket,) {

        this.isArriveObs = fromEventPattern<{
            locationId: string,
            ack: (...args: any[]) => void;
        }>((next) => socket.on("is_arrive", (msg, ack) => {
            next({ ...msg, ack });
        }))

        this.isAwayObs = fromEventPattern<{
            locationId: string,
            ack: (...args: any[]) => void;
        }>((next) => socket.on("is_away", (msg, ack) => {
            next({ ...msg, ack });
        }))

        // socket.on("is_away", (data: string, ack) => {
        //     const jMsg = JSON.parse(data);
        //     console.log(jMsg);

        //     ack({
        //         return_code: "0000",
        //         locationId: jMsg.locationId
        //     })
        // })
    }
}

export default WsServer;