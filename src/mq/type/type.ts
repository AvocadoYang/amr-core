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

export interface PublishOptions {
    expiration?: string;
    retries?: number;
    retryDelay?: number;
    persistent?: boolean    
}

