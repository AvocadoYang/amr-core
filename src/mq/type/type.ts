import { MAC } from "~/configs"

// Exchanges
export const HEARTBEAT_EX = "amr.heartbeat.topic";
export const RES_EX = "amr.res.topic";
export const IO_EX = "amr.io.topic";
export const HANDSHAKE_EX = "amr.handshake.topic"; // optional dedicated control exchange

export const IO_QUEUE = "qams.io.queue";
export const HEARTBEAT_PONG_QUEUE = "qams.heartbeat.pong.queue"

//Queues: Qams -> amr 
export const heartbeatPingQName = `${MAC}.heartbeat.ping.queue`;
export const a2q_handshakeQName = `${MAC}.a2q.handshake.queue`;
export const a2q_ResponseQName = `${MAC}.a2q.handshake.res.queue`;
export const q2a_ResponseQName = `${MAC}.q2a.handshake.res.queue`;
export const q2a_handshakeQName = `${MAC}.q2a.handshake.queue`;

export const dynamicListener = [
    heartbeatPingQName,
    q2a_handshakeQName,
    q2a_ResponseQName
]
export interface PublishOptions {
    expiration?: string;
    persistent?: boolean
}

export const volatile = ["pose", 'errorInfo', "currentId", "poseAccurate", "isRegistered"];


