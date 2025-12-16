import config from "~/configs"

// Exchanges
export const REQ_EX = "amr.req.topic";
export const RES_EX = "amr.res.topic";
export const IO_EX = "amr.io.topic";
export const CONTROL_EX = "amr.control.topic"; // optional dedicated control exchange


// Queues
export const PROMISE_RES_QUEUE = "promise.res.queue";
export const VOLATILE_RES_QUEUE = "volatile.res.queue";
export const IO_QUEUE = "amr.io.queue";
export const REGISTER_QUEUE = "qams.register.queue";
export const HANDSHAKE_IO_QUEUE = "amr.io.handshake.queue";


export const controlQName = `amr.${config.MAC}.control.queue`

export const reqQName = `amr.${config.MAC}.req.queue`

export const ioQFromQAMS = `amr.${config.MAC}.io.form.qams.queue`

export const responseQName = `amr.${config.MAC}.message.res.queue`

export interface PublishOptions {
    expiration?: string;
    retries?: number;
    retryDelay?: number;
    persistent?: boolean
}

export const volatile = ["pose", 'errorInfo', "currentId", "poseAccurate", "isRegistered"];


