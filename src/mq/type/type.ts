import config from "~/configs"

// Exchanges
export const HEARTBEAT_EX = "amr.heartbeat.topic";
export const RES_EX = "amr.res.topic";
export const IO_EX = "amr.io.topic";
export const CONTROL_EX = "amr.control.topic"; // optional dedicated control exchange

export const IO_QUEUE = "qams.io.queue";
export const HEARTBEAT_PONG_QUEUE = "qams.heartbeat.pong.queue"

//Queues: Qams -> amr 
export const heartbeatPingQName = `${config.MAC}.heartbeat.ping.queue`;
export const a2q_handshakeQName = `${config.MAC}.qams.handshake.queue`;
export const q2a_amrResponseQName = `${config.MAC}.amr.handshake.res.queue`;
export const a2q_qamsResponseQName = `${config.MAC}.qams.control.res.queue`;
export const q2a_controlQName = `${config.MAC}.amr.control.queue`;

export const dynamicListener = [
    heartbeatPingQName,
    q2a_controlQName,
    q2a_amrResponseQName
]
export interface PublishOptions {
    expiration?: string;
    retries?: number;
    retryDelay?: number;
    persistent?: boolean
}

export const volatile = ["pose", 'errorInfo', "currentId", "poseAccurate", "isRegistered"];


