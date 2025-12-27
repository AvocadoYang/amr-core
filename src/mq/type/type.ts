import config from "~/configs"

// Exchanges
export const HEARTBEAT_EX = "amr.heartbeat.topic";
export const REQ_EX = "amr.req.topic";
export const RES_EX = "amr.res.topic";
export const IO_EX = "amr.io.topic";
export const CONTROL_EX = "amr.control.topic"; // optional dedicated control exchange


// Queues: Qams <- amr
export const PROMISE_RES_QUEUE = "qams.promise.res.queue";
export const VOLATILE_RES_QUEUE = "qams.volatile.res.queue";
export const IO_QUEUE = "qams.io.queue";
export const IO_HEARTBEAT_QUEUE = "qams.io.heartbeat_queue";
export const HANDSHAKE_IO_QUEUE = "qams.io.handshake.queue";


//Queues: Qams -> amr 
export const heartbeatPingQName = `heartbeat.ping.queue.${config.MAC}`
export const heartbeatPongQName = `heartbeat.pong.queue.${config.MAC}`
export const controlQName = `amr.control.queue.${config.MAC}`
export const reqQName = `amr.req.queue.${config.MAC}`
export const ioQFromQAMS = `amr.io.form.qams.queue.${config.MAC}`
export const responseQName = `amr.message.res.queue.${config.MAC}`

export interface PublishOptions {
    expiration?: string;
    retries?: number;
    retryDelay?: number;
    persistent?: boolean
}

export const volatile = ["pose", 'errorInfo', "currentId", "poseAccurate", "isRegistered"];


