import * as amqp from "amqplib";
import winston from 'winston';
import { infoLogger, warnLogger, errorLogger, rb_transactionLogger, debugLogger, rb_heartbeatLogger } from "~/logger/logger";
import { Subject } from "rxjs";
import { MAC, RABBIT_MQ_HEARTBEAT, RABBIT_MQ_HOST, RABBIT_MQ_PASSWORD, RABBIT_MQ_PORT, RABBIT_MQ_USER } from "~/configs"
import * as faker from 'faker';
import { isConnected, Output } from "~/actions/rabbitmq/output";
import { RequestMsgType, ResponseMsgType, sendCargoVerity, sendHeartBeatResponse } from "./transactionsWrapper";
import { AllRes } from "./type/res";
import { RES_EX, IO_EX, CONTROL_EX, PublishOptions, volatile, HEARTBEAT_EX, heartbeatPingQName, q2a_controlQName, q2a_amrResponseQName, a2q_handshakeQName, a2q_qamsResponseQName, HEARTBEAT_PONG_QUEUE } from "./type/type";
import { AllControl, HEARTBEAT } from "./type/control";
import { formatDate } from "~/helpers/system";
import { ReturnCode } from "./type/returnCode";
import { CONNECT_STATUS, TRANSACTION_INFO } from "~/types/status";
import { blackList, CMD_ID } from "./type/cmdId";

export default class RabbitClient {
    private machineID: string;
    private connection: amqp.ChannelModel | null = null
    private channel: amqp.Channel | null = null;
    private reconnecting = false;
    private reconnectAttempts = 0;
    private manualClose = false;
    private heartbeatOutput$: Subject<HEARTBEAT> = new Subject();
    private resTransactionOutput$: Subject<AllRes> = new Subject();
    private controlTransactionOutput$: Subject<AllControl> = new Subject();


    private lastReceiveReq: Map<string, {
        session: string
    }> = new Map();



    private output$: Subject<Output>

    private pendingMessages: {
        exchange: string;
        key: string;
        buffer: Buffer;
        jMsg: any;
        options: PublishOptions;
        flag: "REQ" | "RES"
    }[] = [];


    private pendingAcks: Map<string, {
        timer: ReturnType<typeof setTimeout>;
        onSettled: (res: AllRes) => void;
    }> = new Map();

    private retryTime: number;
    constructor(
        private info: TRANSACTION_INFO,
        private consumedQueues: Map<string, string>,
        private connectStatus: CONNECT_STATUS,
        option: { retryTime?: number } = {}
    ) {
        this.output$ = new Subject();
        this.machineID = MAC;
        this.retryTime = option.retryTime ?? 5000

        this.connect();
    }


    public async connect() {
        this.manualClose = false;
        try {
            const [connection, url] = await this.connectWithFailover();
            this.connection = connection

            this.connection.on("error", (err) => this.handleDisconnect("Connection error", err));
            this.connection.on("close", () => this.handleDisconnect("Connection closed"));

            this.channel = await this.connection.createChannel();

            this.channel.on("error", (err) => this.handleDisconnect("Channel error", err));
            this.channel.on("close", () => this.handleDisconnect("Channel closed"));
            this.channel.prefetch(10)


            this.reconnectAttempts = 0;

            infoLogger.info(`Connected to ${url}`, {
                title: "RabbitMQ",
                type: "network"
            })
            await this.init();
            this.output$.next(isConnected({ isConnected: true }))
            await this.flushPendingMessages();

        } catch (err) {
            this.scheduleReconnect();
        }
    }

    // Shared handler for connection/channel "error" and "close" events - both fire on
    // every real disconnect, so `reconnecting` below dedupes them into a single retry loop.
    private handleDisconnect(reason: string, err?: Error) {
        if (this.manualClose) return;

        if (err) {
            errorLogger.error(reason, {
                title: "RabbitMQ",
                type: "network",
                status: err.message
            });
        } else {
            warnLogger.warn(`${reason}. Reconnecting...`, {
                title: "RabbitMQ",
                type: "network"
            });
        }


        this.consumedQueues.clear();
        this.output$.next(isConnected({ isConnected: false }));
        this.channel = null;
        this.connection = null;
        this.scheduleReconnect();
    }

    private scheduleReconnect() {
        if (this.reconnecting || this.manualClose) return;
        this.reconnecting = true;

        const delay = this.retryTime;
        this.reconnectAttempts++;

        infoLogger.info(`Reconnecting RabbitMQ in ${delay}ms (attempt ${this.reconnectAttempts})...`, {
            title: "RabbitMQ",
            type: "network connection",
        });

        setTimeout(async () => {
            // Reset before attempting, not after: if connect() fails again it calls
            // scheduleReconnect() from within this same tick, and that call needs to see
            // reconnecting === false or the next retry never gets scheduled.
            this.reconnecting = false;
            await this.connect();
        }, delay);
    }

    private async connectWithFailover(): Promise<[amqp.ChannelModel, string]> {
        // AMQP heartbeat is specified in seconds (unlike keepAliveDelay below, which is ms) - do not scale it.
        const url = `amqp://${RABBIT_MQ_USER}:${RABBIT_MQ_PASSWORD}@${RABBIT_MQ_HOST}:${RABBIT_MQ_PORT}?heartbeat=${RABBIT_MQ_HEARTBEAT}`;
        try {
            const conn = await amqp.connect(url, { keepAlive: true, keepAliveDelay: RABBIT_MQ_HEARTBEAT * 1000 });
            return [conn, url];
        } catch (err) {
            errorLogger.error(`Connection failed with ${url}`, {
                title: "RabbitMQ",
                type: "network",
                status: (err as Error).message
            });
            throw new Error();
        }
    }



    private async createQueue(
        queueName: string,
        options: { durable?: boolean; quorum?: boolean; exclusive?: boolean; autoDelete?: boolean; arguments?: any } = {}
    ) {
        if (!this.channel) throw new Error("Channel is not available");
        const queueOptions: amqp.Options.AssertQueue = {
            durable: options.durable ?? true,
            exclusive: options.exclusive ?? false,
            autoDelete: options.autoDelete ?? false,
            arguments: options.arguments ?? {},
        };

        if (options.quorum) {
            queueOptions.arguments!["x-queue-type"] = "quorum";
        }

        const queue = await this.channel.assertQueue(queueName, queueOptions);
        debugLogger.info(` Queue "${queueName}" is ready. Options`, {
            title: "RabbitMQ",
            type: "queue setting",
            status: queueOptions
        });
        return queue;
    }

    private async createExchange(
        exchangeName: string,
        type: "direct" | "fanout" | "topic" | "headers" = "direct",
        options: { durable?: boolean; internal?: boolean; autoDelete?: boolean; arguments?: any } = {}
    ) {
        if (!this.channel) throw new Error("Channel is not available");

        const exchangeOptions: amqp.Options.AssertExchange = {
            durable: options.durable ?? true,
            internal: options.internal ?? false,
            autoDelete: options.autoDelete ?? false,
            arguments: options.arguments ?? {},
        };

        const exchange = await this.channel.assertExchange(exchangeName, type, exchangeOptions);

        debugLogger.info(`Exchange "${exchangeName}" is ready.`, {
            title: "RabbitMQ",
            type: "exchange setting",
            status: { type, ...exchangeOptions }
        });
        return exchange;
    }


    private async bindQueue(queueName: string, exchangeName: string, pattern = "") {
        if (!this.channel) throw new Error("Channel is not available");
        await this.channel.bindQueue(queueName, exchangeName, pattern);

        debugLogger.info(`Queue "${queueName}" bound to exchange "${exchangeName}"`, {
            title: "RabbitMQ",
            type: "bind",
            status: { queue: queueName, exchange: exchangeName, pattern }
        });
    }

    public sendToReqQueue(queueName: string, message: string, cmd_id: string) {
        const msg = JSON.stringify({ sender: this.machineID, msg: message, flag: "REQ" });
        // if (!this.channel) throw new Error("Channel is not available");
        if (!this.channel) return;
        this.channel.sendToQueue(queueName, Buffer.from(msg));
        debugLogger.info(` send message ${cmd_id} to "${queueName}" -`, {
            title: "RabbitMQ",
            type: "publish",
            status: JSON.parse(message)
        });
    }

    public sendToResQueue(queueName: string, message: string, cmd_id: string) {
        const msg = JSON.stringify({ sender: this.machineID, msg: message, flag: "RES" });
        if (!this.channel) throw new Error("Channel is not available");
        this.channel.sendToQueue(queueName, Buffer.from(msg));
        debugLogger.info(` send message ${cmd_id} to "${queueName}" -`, {
            title: "RabbitMQ",
            type: "publish",
            status: JSON.parse(message)
        });
    }

    public async reqPublish(
        exchangeName: string,
        routingKey: string,
        message: RequestMsgType,
        options?: PublishOptions,
        customId?: string
    ) {
        const id = customId ?? faker.datatype.uuid();
        const flag = "REQ";

        const jMsg = {
            id,
            sender: "AMR_CORE",
            serialNum: this.machineID,
            session: this.info.session,
            flag,
            timestamp: String(new Date().getTime()),
            payload: { id, ...message, amrId: this.info.amrId }
        };

        const sMsg = JSON.stringify(jMsg);
        const buffer = Buffer.from(sMsg);
        let result = false
        try {
            result = await this.publish(exchangeName, routingKey, buffer, flag, jMsg, options);
        } catch (err: unknown) {
            errorLogger.error(getErrorMessage(err), {
                title: "RabbitMQ",
                type: "rabbitmq service"
            });
        }
        return result
    }

    /**
     * Publish a REQ and wait for a matching RES by id, retrying the identical buffer
     * (same id, so idempotent on a receiver that dedups by id) on timeout. Never touches
     * mission state on exhaustion - just resolves null so the caller decides what "still
     * unresolved" means; the next reconcile point (register/digest) is what recovers it.
     */
    public reqPublishWithAck(
        exchangeName: string,
        routingKey: string,
        message: RequestMsgType,
        options?: PublishOptions,
        customId?: string,
        ackOptions: { timeoutMs?: number; maxRetries?: number } = {}
    ): Promise<AllRes | null> {
        const { timeoutMs = 3000, maxRetries = 3 } = ackOptions;
        const id = customId ?? faker.datatype.uuid();
        const flag = "REQ";
        const jMsg = {
            id,
            sender: "AMR_CORE",
            serialNum: this.machineID,
            session: this.info.session,
            flag,
            timestamp: String(new Date().getTime()),
            payload: { id, ...message, amrId: this.info.amrId }
        };
        const buffer = Buffer.from(JSON.stringify(jMsg));

        return new Promise<AllRes | null>((resolve) => {
            const send = (attempt: number) => {
                this.publish(exchangeName, routingKey, buffer, flag, jMsg, options);
                const timer = setTimeout(() => {
                    if (attempt < maxRetries) {
                        warnLogger.warn(`ack timeout, retrying (${attempt}/${maxRetries})`, {
                            title: "RabbitMQ",
                            type: "ack retry",
                            status: { id, exchange: exchangeName, routingKey }
                        });
                        send(attempt + 1);
                    } else {
                        errorLogger.error(`ack exhausted after ${maxRetries} attempts, giving up - left unresolved for next reconcile point`, {
                            title: "RabbitMQ",
                            type: "ack exhausted",
                            status: { id, exchange: exchangeName, routingKey }
                        });
                        this.pendingAcks.delete(id);
                        resolve(null);
                    }
                }, timeoutMs);

                this.pendingAcks.set(id, {
                    timer,
                    onSettled: (res) => {
                        clearTimeout(timer);
                        this.pendingAcks.delete(id);
                        resolve(res);
                    }
                });
            };
            send(1);
        });
    }

    /**
     * Settle an outstanding reqPublishWithAck() when its matching RES arrives - no-op if
     * nothing is pending for this id (a plain reqPublish, or an already-settled/exhausted ack).
     */
    public settlePendingAck(res: AllRes) {
        const entry = this.pendingAcks.get(res.payload.id);
        if (entry) entry.onSettled(res);
    }

    public async resPublish(
        exchangeName: string,
        routingKey: string,
        message: ResponseMsgType,
        options?: PublishOptions
    ) {
        const flag = "RES";
        const messagePair = this.lastReceiveReq.get(message.id);
        if (!messagePair) {
            errorLogger.error("can not get request message for response", {
                title: "RabbitMQ",
                type: "unexpected error",
                status: message
            });
            return false;
        }
        const jMsg = {
            id: message.id,
            sender: "AMR_CORE",
            serialNum: this.machineID,
            session: messagePair.session,
            flag,
            timestamp: String(new Date().getTime()),
            payload: message
        };
        this.lastReceiveReq.delete(message.id);

        const sMsg = JSON.stringify(jMsg);


        const buffer = Buffer.from(sMsg);

        try {
            const result = await this.publish(exchangeName, routingKey, buffer, flag, jMsg, options);
        } catch (err: unknown) {
            errorLogger.error(getErrorMessage(err), {
                title: "RabbitMQ",
                type: "rabbitmq service"
            });
        }
    }

    public async consume<A>(queueName: string, onMessage: (msg: A) => void, noAck = false) {
        if (!this.channel) throw new Error("Channel is not available");
        const localChannel = this.channel;
        if (this.consumedQueues.has(queueName)) {
            debugLogger.info(`Queue ${queueName} already being consumed.`, {
                title: "RabbitMQ",
                type: "consume queue"
            });
            return this.consumedQueues.get(queueName);
        } else {
            debugLogger.info(`start consume queue: ${queueName}`, {
                title: "RabbitMQ",
                type: "consume queue",
            });
        }
        const consumer = await this.channel.consume(queueName, (msg) => {
            if (!msg) return;

            let data: any;
            try {
                data = JSON.parse(msg.content.toString());
            } catch (err) {
                errorLogger.error("Failed to parse message", {
                    title: "RabbitMQ",
                    type: "parse error",
                    status: err
                });
                try {
                    // unparseable content can never succeed on redelivery - ack to drop it,
                    // 用舊 channel ack，而非 this.channel!!!
                    if (!noAck) localChannel.ack(msg);
                } catch (e) {
                    console.error("ack failed:", e);
                }
                return;
            }

            try {
                const { payload, session } = data;
                if (data.flag == 'RES') {
                    if (!blackList.includes(payload.cmd_id)) {
                        rb_transactionLogger.info(`Receive [response] message (${payload.cmd_id}) -`, {
                            title: "RabbitMQ",
                            type: "receive",
                            response: { ...payload, session }
                        });
                    }
                } else {
                    if (!blackList.includes(payload.cmd_id)) {
                        rb_transactionLogger.info(`Receive [request] message (${payload.cmd_id}) -`, {
                            title: "RabbitMQ",
                            type: "receive",
                            request: { ...payload, session }
                        });
                    }
                    if (payload.id) {
                        this.lastReceiveReq.set(payload.id, { session })
                    } else {
                        warnLogger.warn(`Receive request (${payload.cmd_id}) with empty id, skip correlation tracking`, {
                            title: "RabbitMQ",
                            type: "receive",
                            status: { ...payload, session }
                        });
                    }
                }

                onMessage(data);

                // 用舊 channel ack，而非 this.channel!!!
                if (!noAck) localChannel.ack(msg);
            } catch (err) {
                // handler threw - the message was never actually processed. Ack-in-finally
                // used to silently drop it here; nack + requeue-once instead so a transient
                // handler failure gets a second chance instead of vanishing.
                errorLogger.error(
                    `onMessage handler threw (${msg.fields.redelivered ? "already retried once, dropping" : "requeuing once"})`, {
                    title: "RabbitMQ",
                    type: "handler error",
                    status: err instanceof Error ? err.message : String(err)
                });
                try {
                    if (!noAck) localChannel.nack(msg, false, !msg.fields.redelivered);
                } catch (e) {
                    console.error("nack failed:", e);
                }
            }
        }, { noAck });
        this.consumedQueues.set(queueName, consumer.consumerTag);
        return consumer.consumerTag;
    }

    public async init() {


        await this.createExchange(HEARTBEAT_EX, "topic", { durable: true });
        await this.createExchange(RES_EX, "topic", { durable: true });
        await this.createExchange(IO_EX, "topic", { durable: true });
        await this.createExchange(CONTROL_EX, "topic", { durable: true });

        await this.createQueue(q2a_controlQName, { durable: true });
        await this.bindQueue(q2a_controlQName, CONTROL_EX, `amr.${MAC}.control.*`);

        await this.createQueue(q2a_amrResponseQName, { durable: true });
        await this.bindQueue(q2a_amrResponseQName, RES_EX, `amr.${MAC}.*.res`);

        await this.createQueue(a2q_handshakeQName, { durable: true });
        await this.bindQueue(a2q_handshakeQName, CONTROL_EX, `qams.${MAC}.handshake.*`);

        await this.createQueue(a2q_qamsResponseQName, { durable: true });
        await this.bindQueue(a2q_qamsResponseQName, RES_EX, `qams.${MAC}.res.*`);

        await this.createQueue(HEARTBEAT_PONG_QUEUE, { durable: true });
        await this.bindQueue(HEARTBEAT_PONG_QUEUE, HEARTBEAT_EX, `qams.heartbeat.pong.*`);

        await this.createQueue(heartbeatPingQName, { autoDelete: false });
        await this.bindQueue(heartbeatPingQName, HEARTBEAT_EX, `amr.heartbeat.ping.${MAC}`);
        await this.channel.purgeQueue(heartbeatPingQName);


    }

    public onHeartbeat(cb: (action: HEARTBEAT) => void) {
        return this.heartbeatOutput$.subscribe(cb);
    }


    public onResTransaction(cb: (action: AllRes) => void) {
        return this.resTransactionOutput$.subscribe(cb);
    }


    public onControlTransaction(cb: (action: AllControl) => void) {
        return this.controlTransactionOutput$.subscribe(cb);
    }


    public subscribe(cb: (action: Output) => void) {
        return this.output$.subscribe(cb);
    }


    public async close() {
        this.manualClose = true;
        await this.channel?.close();
        await this.connection?.close();
        this.channel = null;
        this.connection = null;

        infoLogger.info(`Connection closed manually.`, {
            title: "Rabbitmq",
            type: "network"
        })
    }

    private isVolatile(exchange: string, routingKey: string): boolean {
        if (exchange !== IO_EX && !exchange.includes("heartbeat")) return false;

        return true;
    }

    private async publish(
        exchange: string,
        key: string,
        buffer: Buffer,
        flag: "REQ" | "RES",
        jMsg: any,
        options: PublishOptions = {},
        mode: string = "normal"
    ): Promise<boolean> {

        const { expiration } = options;

        try {
            if (!this.channel) throw new Error("Rabbit channel is not available");
            const publishOptions = expiration
                ? { expiration }
                : undefined;
            const buffered = this.channel.publish(exchange, key, buffer, publishOptions);
            if (flag == "REQ") {
                if (!blackList.includes(jMsg.payload.cmd_id)) {
                    rb_transactionLogger.info(`Published [request] message (${jMsg.payload.cmd_id}) to exchange- "${exchange}", routingKey in mode: ${mode}- "${key}"`, {
                        title: "RabbitMQ",
                        type: "publish",
                        request: { ...jMsg.payload, id: jMsg.id, session: jMsg.session, options }
                    });
                }
            } else {
                if (jMsg.payload.cmd_id == CMD_ID.HEARTBEAT) {
                    rb_heartbeatLogger.info("Send heartbeat to QAMS", {
                        title: "system",
                        type: "ack",
                        status: { id: jMsg.payload.id, heartbeat: jMsg.payload.heartbeat, session: jMsg.session }
                    })
                    debugLogger.info("Send heartbeat to QAMS", {
                        title: "system",
                        type: "ack",
                        status: { id: jMsg.payload.id, heartbeat: jMsg.payload.heartbeat, session: jMsg.session }
                    })
                }
                if (!blackList.includes(jMsg.payload.cmd_id)) {
                    rb_transactionLogger.info(`Published [response] message (${jMsg.payload.cmd_id}) to exchange- "${exchange}", routingKey in mode: ${mode}- "${key}"`, {
                        title: "RabbitMQ",
                        type: "publish",
                        response: { ...jMsg.payload, session: jMsg.session }
                    });
                }
            }

            if (!buffered) {
                // publish() returning false is Node stream backpressure, not a failed
                // publish - the message is already queued for delivery. Wait for 'drain'
                // instead of retrying, otherwise a retry would re-send and duplicate it.
                await new Promise<void>((resolve) => this.channel!.once("drain", resolve));
            }

            return true;
        } catch (err: unknown) {
            if (this.isVolatile(exchange, key)) {
                return false;
            }
            // channel.publish() doesn't throw for transient network/broker failures - those surface
            // asynchronously via the channel's error/close events (handled in connect()), which already
            // trigger a reconnect + flushPendingMessages(). The only realistic failure here is the
            // channel not existing yet, so just queue for that flush instead of retrying blind.
            const data = JSON.parse(buffer.toString());
            this.pendingMessages.push({ exchange, key, buffer, flag, jMsg, options });
            warnLogger.warn(
                `Failed to publish (${getErrorMessage(err)}), store message to pending queue, now pending message array length: ${this.pendingMessages.length} -`, {
                title: "RabbitMQ",
                type: "transaction",
                status: { exchange, key, data }
            });
            return false;
        }
    }


    private async flushPendingMessages() {
        if (!this.channel || this.pendingMessages.length === 0) return;

        infoLogger.info(`Flushing ${this.pendingMessages.length} pending messages...`, {
            title: "RabbitMQ",
            type: "flush cache"
        });

        const messages = [...this.pendingMessages];
        this.pendingMessages = []; // 先清空避免重複送

        for (const msg of messages) {
            try {
                await this.publish(
                    msg.exchange,
                    msg.key,
                    msg.buffer,
                    msg.flag,
                    msg.jMsg,
                    msg.options,
                    "cache"
                );
            } catch (err) {
                // 如果 flush 時仍然失敗，先放回 pending
                this.pendingMessages.push(msg);
            }
        }
    }


    public async consumeTopic() {
        if (!this.channel) return [];
        await this.flushPendingMessages();

        const tags = await Promise.all([
            this.consume<HEARTBEAT>(heartbeatPingQName, (msg) => {
                if (!this.connectStatus.qams_isConnect) {
                    debugLogger.info("Drop heartbeat ping: QAMS not connected yet", {
                        title: "RabbitMQ",
                        type: "heartbeat",
                        status: { session: msg.session }
                    });
                    return;
                }
                if (msg.session !== this.info.session) {
                    debugLogger.info("Drop heartbeat ping: session mismatch", {
                        title: "RabbitMQ",
                        type: "heartbeat",
                        status: { expected: this.info.session, received: msg.session }
                    });
                    return;
                }
                this.heartbeatOutput$.next(msg);
            }, true),

            this.consume<AllRes>(q2a_amrResponseQName, (msg) => {
                // settle any outstanding reqPublishWithAck() regardless of session/forwarding
                // decision below - it's still a legitimate response to our own request.
                this.settlePendingAck(msg);

                // register response establishes a brand new session, so it can never match
                // this.info.session yet - it must always be forwarded regardless of session.
                if (msg.payload.cmd_id === CMD_ID.REGISTER) {
                    this.resTransactionOutput$.next(msg);
                    return;
                }
                const checkSession = (msg.session == this.info.session);
                if (!checkSession) {
                    const canPass = this.info.return_code == ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS;
                    if (canPass) this.resTransactionOutput$.next(msg);
                } else {
                    this.resTransactionOutput$.next(msg);
                };
            }),

            this.consume<AllControl>(q2a_controlQName, (msg) => {
                const checkSession = (msg.session == this.info.session);
                if (!checkSession) {
                    const canPass = this.info.return_code == ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS;
                    if (canPass) this.controlTransactionOutput$.next(msg);
                } else {
                    this.controlTransactionOutput$.next(msg);
                }
            })
        ]);
        return tags;
    }


}
function uuid(): string {
    throw new Error("Function not implemented.");
}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

