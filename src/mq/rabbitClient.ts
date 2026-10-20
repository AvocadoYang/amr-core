import * as amqp from "amqplib";
import winston from 'winston';
import { infoLogger, warnLogger, errorLogger, rb_transactionLogger, debugLogger, rb_heartbeatLogger } from "~/logger/logger";
import { Subject, take } from "rxjs";
import { MAC, RABBIT_MQ_HEARTBEAT, RABBIT_MQ_HOST, RABBIT_MQ_PASSWORD, RABBIT_MQ_PORT, RABBIT_MQ_USER } from "~/configs"
import * as faker from 'faker';
import { isConnected, Output } from "~/actions/rabbitmq/output";
import { RequestMsgType, ResponseMsgType, sendCargoVerity, sendHeartBeatResponse } from "./transactionsWrapper";
import { AllRes, CONNECTION_HEATH_RES, REGISTER_RES } from "./type/res";
import { RES_EX, IO_EX, HANDSHAKE_EX, PublishOptions, volatile, HEARTBEAT_EX, REGISTER_REQ_QUEUE, heartbeatPingQName, q2a_handshakeQName, q2a_ResponseQName, a2q_handshakeQName, a2q_ResponseQName, HEARTBEAT_PONG_QUEUE, dynamicListener, q2a_registerResponseQName, q2a_ioQName } from "./type/type";
import { AllHandshake, HEARTBEAT } from "./type/handshake";
import { AllIO } from './type/io'
import { ReturnCode } from "./type/returnCode";
import { CONNECT_STATUS, TRANSACTION_INFO } from "~/types/status";
import { blackList, CMD_ID } from "./type/cmdId";


type OutboxEntry = {
    exchange: string;
    key: string;
    flag: "REQ" | "RES";
    jMsg: any;
    options: PublishOptions;
    // channel generation this entry was last handed to; anything not equal to the current
    // generation has no live confirm callback and must be (re)sent on the next flush
    sentGen: number;
};

const OUTBOX_LIMIT = 500;
const KEEP_IN_OUTBOX: string[] = [CMD_ID.READ_STATUS, CMD_ID.MISSION_LOST];

export default class RabbitClient {
    private machineID: string;
    // amqplib's recovering wrapper: reconnects with backoff and re-runs setup() each time
    private connection: amqp.RecoveringChannelModel | null = null
    // the live underlying connection handed to setup(), used to force a full recovery
    // when one of our channels dies on its own (recovery only watches the connection)
    private rawConnection: amqp.ChannelModel | null = null;
    // consumers + volatile (IO / heartbeat / expiring) publishes - fire and forget
    private channel: amqp.Channel | null = null;
    // everything that must not be lost - held in the outbox until the broker confirms it
    private confirmChannel: amqp.ConfirmChannel | null = null;
    private generation = 0;
    private manualClose = false;

    // keyed by message id, so an ack-retry of the same id overwrites instead of duplicating
    private outbox: Map<string, OutboxEntry> = new Map();
    // opened by main once the QAMS session is settled (CH reconciled) - until then reliable
    // messages are only queued, so they get stamped with the session QAMS will accept
    private outboxOpen = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatOutput$: Subject<HEARTBEAT> = new Subject<HEARTBEAT>();
    private resTransactionOutput$: Subject<AllRes> = new Subject<AllRes>();
    public registerResTransactionOutput$: Subject<REGISTER_RES | CONNECTION_HEATH_RES> = new Subject<REGISTER_RES | CONNECTION_HEATH_RES>();
    private controlTransactionOutput$: Subject<AllHandshake> = new Subject<AllHandshake>();
    private q2aIoTransactionOutput$: Subject<AllIO> = new Subject<AllIO>();


    private lastReceiveReq: Map<string, {
        session: string
    }> = new Map();



    private output$: Subject<Output>

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
        this.retryTime = option.retryTime ?? 5000;
        this.connect();
    }


    public async connect() {
        this.manualClose = false;
        // AMQP heartbeat is specified in seconds (unlike keepAliveDelay below, which is ms) - do not scale it.
        const url = `amqp://${RABBIT_MQ_USER}:${RABBIT_MQ_PASSWORD}@${RABBIT_MQ_HOST}:${RABBIT_MQ_PORT}?heartbeat=${RABBIT_MQ_HEARTBEAT}`;

        this.connection = await amqp.connect(url, {
            keepAlive: true,
            keepAliveDelay: RABBIT_MQ_HEARTBEAT * 1000,
            recovery: {
                initialDelay: 500,
                maxDelay: this.retryTime,
                factor: 2,
                jitter: 0.2,
                maxRetries: Infinity,
                // hand back the handle immediately so the listeners below see the first attempt too
                waitForConnect: false,
                // runs after every successful (re)connect, before 'connect' is emitted - a throw
                // here closes that connection and schedules another attempt
                setup: (model) => this.setup(model),
            },
        });

        this.connection.on("connect", () => {
            infoLogger.info(`Connected to ${RABBIT_MQ_HOST}:${RABBIT_MQ_PORT}`, {
                title: "RabbitMQ",
                type: "network"
            });
            this.output$.next(isConnected({ isConnected: true }));
        });

        this.connection.on("disconnect", (err: Error) => this.handleDisconnect("Connection lost", err));

        this.connection.on("connect-failed", (err: Error) => {
            this.resetChannels();
            errorLogger.error(`Connection failed with ${RABBIT_MQ_HOST}:${RABBIT_MQ_PORT}`, {
                title: "RabbitMQ",
                type: "network",
                status: err.message
            });
        });

        this.connection.on("reconnect-scheduled", ({ attempt, delay }: { attempt: number, delay: number }) => {
            infoLogger.info(`Reconnecting RabbitMQ in ${delay}ms (attempt ${attempt})...`, {
                title: "RabbitMQ",
                type: "network connection",
            });
        });

        // forwarded connection-level errors - always followed by 'disconnect', but an
        // EventEmitter 'error' with no listener would crash the process
        this.connection.on("error", (err: Error) => {
            errorLogger.error("Connection error", {
                title: "RabbitMQ",
                type: "network",
                status: err.message
            });
        });
    }

    /**
     * Called by amqplib recovery on every (re)connect. Channels belong to the underlying
     * connection, so they (and every consumer on them) are rebuilt here each time.
     */
    private async setup(model: amqp.ChannelModel) {
        const channel = await model.createChannel();
        const confirmChannel = await model.createConfirmChannel();

        for (const [name, ch] of [["channel", channel], ["confirm channel", confirmChannel]] as const) {
            ch.on("error", (err: Error) => {
                errorLogger.error(`${name} error`, {
                    title: "RabbitMQ",
                    type: "network",
                    status: err.message
                });
            });
            ch.on("close", () => {
                // deferred: on a real connection loss the channels close first, and the
                // 'disconnect' handler clears rawConnection right after - only a channel that
                // died on its own (e.g. a 404/406 channel error) still finds its connection here.
                // Recovery only watches the connection, so close it to force a full re-setup.
                setImmediate(() => {
                    if (this.manualClose || this.rawConnection !== model) return;
                    warnLogger.warn(`${name} closed while connection is still up, forcing reconnect`, {
                        title: "RabbitMQ",
                        type: "network"
                    });
                    model.close().catch(() => { });
                });
            });
        }

        await channel.prefetch(10);

        this.rawConnection = model;
        this.channel = channel;
        this.confirmChannel = confirmChannel;
        this.generation++;

        // anything that was confirm-pending on the dead channel is still in the outbox; it is
        // resent once main reopens the outbox after the CONNECTION_HEALTH reconcile
        await this.declareTopology();
    }

    private resetChannels() {
        this.consumedQueues.clear();
        this.channel = null;
        this.confirmChannel = null;
        this.rawConnection = null;
    }

    private handleDisconnect(reason: string, err?: Error) {
        if (this.manualClose) return;

        errorLogger.error(`${reason}. Reconnecting...`, {
            title: "RabbitMQ",
            type: "network",
            status: err?.message
        });

        this.resetChannels();
        this.outboxOpen = false;
        this.output$.next(isConnected({ isConnected: false }));
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

        let result = false
        try {
            result = await this.publish(exchangeName, routingKey, flag, jMsg, options);
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

        return new Promise<AllRes | null>((resolve) => {
            const send = (attempt: number) => {
                // same id every attempt - while disconnected this just refreshes the one outbox entry
                this.publish(exchangeName, routingKey, flag, jMsg, options);
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

        try {
            await this.publish(exchangeName, routingKey, flag, jMsg, options);
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
            infoLogger.info(`Queue ${queueName} already being consumed.`, {
                title: "RabbitMQ",
                type: "consume queue"
            });
            return this.consumedQueues.get(queueName);
        } else {
            infoLogger.info(`start consume queue: ${queueName}`, {
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
                        if (!blackList.includes(payload.cmd_id) || payload.cmd_id == CMD_ID.HEARTBEAT) {
                            this.lastReceiveReq.set(payload.id, { session })
                        }
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

    public async stopConsumeQueue(queueNames: string[], reason: string) {
        debugLogger.info(`run stop-consuming process. ${reason}`, {
            title: "RabbitMQ",
            type: 'stop consume',
            status: {
                still_consume: [...this.consumedQueues.keys()],
                need_stop: queueNames,
            },
        });
        if (!this.channel) {
            this.consumedQueues.clear();
            debugLogger.info('end of stop-consuming process (channel is null)', {
                title: "RabbitMQ",
                type: 'stop consume',
                status: { still_consume: [...this.consumedQueues.keys()] },
            });
            return;
        }
        for (const queueName of queueNames) {
            if (!this.consumedQueues.has(queueName)) continue;
            try {
                await this.channel.cancel(this.consumedQueues.get(queueName));
                this.consumedQueues.delete(queueName);
                warnLogger.warn(`stop consume queue: ${queueName}`, {
                    title: "RabbitMQ",
                    type: "stop consume"
                });
            } catch (e) {
                // channel 可能已經 close，忽略
            }
        }
        debugLogger.info('end of stop-consuming process', {
            title: "RabbitMQ",
            type: 'stop consume',
            status: { still_consume: [...this.consumedQueues.keys()] },
        });
    }


    public async pauseDynamicConsumers(reason: string) {

        await this.stopConsumeQueue(dynamicListener, reason);
    }

    // exchanges/queues/bindings plus the always-on consumers - run from setup() on every (re)connect
    private async declareTopology() {
        await this.createExchange(HEARTBEAT_EX, "topic", { durable: true });
        await this.createExchange(RES_EX, "topic", { durable: true });
        await this.createExchange(IO_EX, "topic", { durable: true });
        await this.createExchange(HANDSHAKE_EX, "topic", { durable: true });


        await this.createQueue(q2a_handshakeQName, {
            durable: true,
        });
        await this.bindQueue(q2a_handshakeQName, HANDSHAKE_EX, `amr.${MAC}.handshake.*`);

        await this.createQueue(q2a_ResponseQName, { durable: true });
        await this.bindQueue(q2a_ResponseQName, RES_EX, `amr.${MAC}.*.res`);

        await this.createQueue(a2q_handshakeQName, { durable: true });
        await this.bindQueue(a2q_handshakeQName, HANDSHAKE_EX, `qams.${MAC}.handshake.*`);

        await this.createQueue(a2q_ResponseQName, { durable: true });
        await this.bindQueue(a2q_ResponseQName, RES_EX, `qams.${MAC}.res.*`);

        await this.createQueue(HEARTBEAT_PONG_QUEUE, { durable: true });
        await this.bindQueue(HEARTBEAT_PONG_QUEUE, HEARTBEAT_EX, `qams.heartbeat.pong.*`);

        await this.createQueue(REGISTER_REQ_QUEUE, { durable: true })
        await this.bindQueue(REGISTER_REQ_QUEUE, HANDSHAKE_EX, `qams.register.req.*.*`);

        await this.createQueue(heartbeatPingQName, { autoDelete: false });
        await this.bindQueue(heartbeatPingQName, HEARTBEAT_EX, `amr.heartbeat.ping.${MAC}`);
        await this.channel.purgeQueue(heartbeatPingQName);

        await this.createQueue(q2a_registerResponseQName, { durable: true });
        await this.bindQueue(q2a_registerResponseQName, RES_EX, `amr.register.res.${MAC}`)
        await this.channel.purgeQueue(q2a_registerResponseQName);

        await this.createQueue(q2a_ioQName, { durable: true });
        await this.bindQueue(q2a_ioQName, IO_EX, `q2a.io.*.${MAC}`);

        await this.consumeFixTopic();


    }

    public onHeartbeat(cb: (action: HEARTBEAT) => void) {
        return this.heartbeatOutput$.subscribe(cb);
    }


    public onResTransaction(cb: (action: AllRes) => void) {
        return this.resTransactionOutput$.subscribe(cb);
    }


    public onRegisterResTransaction(
        cb: (action: REGISTER_RES | CONNECTION_HEATH_RES) => void,
    ) {

        return this.registerResTransactionOutput$.subscribe((action) => {
            cb(action);
        });
    }

    public onControlTransaction(cb: (action: AllHandshake) => void) {
        return this.controlTransactionOutput$.subscribe(cb);
    }

    public onIoTransaction(cb: (action: AllIO) => void) {
        return this.q2aIoTransactionOutput$.subscribe(cb)
    }


    public subscribe(cb: (action: Output) => void) {
        return this.output$.subscribe(cb);
    }

    // no using
    public async close() {
        this.manualClose = true;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        // closing the recovering handle stops recovery and closes the live connection with it
        await this.connection?.close();
        this.resetChannels();
        this.connection = null;

        infoLogger.info(`Connection closed manually.`, {
            title: "Rabbitmq",
            type: "network"
        })
    }

    // IO / heartbeat traffic is a continuous stream - a late copy is worse than none
    private isVolatile(exchange: string): boolean {
        return exchange === IO_EX || exchange.includes("heartbeat");
    }

    /**
     * Volatile or expiring messages go straight out on the plain channel and are dropped while
     * disconnected. Everything else goes through the outbox and only leaves it once the broker
     * confirms it, so it survives any disconnect and is resent afterwards. A confirm lost in
     * flight means resending something the broker already has, so receivers must dedup by id.
     */
    private async publish(
        exchange: string,
        key: string,
        flag: "REQ" | "RES",
        jMsg: any,
        options: PublishOptions = {},
    ): Promise<boolean> {
        if (this.isVolatile(exchange) || options.expiration) {
            return this.publishDirect(exchange, key, flag, jMsg, options);
        }
        this.enqueue(exchange, key, flag, jMsg, options);
        return true;
    }

    private async publishDirect(
        exchange: string,
        key: string,
        flag: "REQ" | "RES",
        jMsg: any,
        options: PublishOptions,
    ): Promise<boolean> {
        const channel = this.channel;
        if (!channel) return false;
        try {
            const publishOptions = options.expiration ? { expiration: options.expiration } : undefined;
            const buffered = channel.publish(exchange, key, Buffer.from(JSON.stringify(jMsg)), publishOptions);
            this.logPublish(exchange, key, flag, jMsg, options, "direct");
            if (!buffered) {
                // publish() returning false is Node stream backpressure, not a failed publish -
                // the frame is already queued. Wait for 'drain' (or the channel dying, so this
                // can't hang across a reconnect) instead of re-sending a duplicate.
                await new Promise<void>((resolve) => {
                    const done = () => {
                        channel.off("drain", done);
                        channel.off("close", done);
                        resolve();
                    };
                    channel.once("drain", done);
                    channel.once("close", done);
                });
            }
            return true;
        } catch (err: unknown) {
            // channel closed under us (IllegalOperationError) - volatile, so just drop it
            return false;
        }
    }

    private enqueue(exchange: string, key: string, flag: "REQ" | "RES", jMsg: any, options: PublishOptions) {
        // an ack-retry of a message that is still unconfirmed (queued, or in flight on the live
        // channel) - the outbox already owns delivering it
        if (this.outbox.has(jMsg.id)) return;

        if (this.outbox.size >= OUTBOX_LIMIT) {
            // a mission result / goal-lost report must never be the one pushed out
            const evict = [...this.outbox.entries()].find(([, e]) => !KEEP_IN_OUTBOX.includes(e.jMsg.payload.cmd_id))
                ?? (this.outbox.entries().next().value as [string, OutboxEntry]);
            const [oldestId, oldest] = evict;
            this.outbox.delete(oldestId);
            errorLogger.error(`outbox full (${OUTBOX_LIMIT}), dropping oldest message`, {
                title: "RabbitMQ",
                type: "outbox",
                status: { id: oldestId, cmd_id: oldest.jMsg.payload.cmd_id, key: oldest.key }
            });
        }

        const entry: OutboxEntry = { exchange, key, flag, jMsg, options, sentGen: -1 };
        this.outbox.set(jMsg.id, entry);

        if (this.outboxOpen) {
            this.sendEntry(jMsg.id, entry);
        } else if (!blackList.includes(jMsg.payload.cmd_id)) {
            warnLogger.warn(`outbox closed, queued message (${jMsg.payload.cmd_id}), outbox size: ${this.outbox.size}`, {
                title: "RabbitMQ",
                type: "outbox",
                status: { id: jMsg.id, exchange, key }
            });
        }
    }

    private sendEntry(id: string, entry: OutboxEntry) {
        const channel = this.confirmChannel;
        if (!channel) return;
        const gen = this.generation;
        // a REQ belongs to the session it is actually delivered in - a REQ queued through a
        // session change would otherwise carry a session QAMS has already retired and be dropped.
        // A RES keeps the session of the request it answers.
        if (entry.flag === "REQ") entry.jMsg.session = this.info.session;
        try {
            entry.sentGen = gen;
            channel.publish(
                entry.exchange,
                entry.key,
                Buffer.from(JSON.stringify(entry.jMsg)),
                { persistent: true, messageId: id },
                (err) => {
                    // discarded or replaced while in flight
                    if (this.outbox.get(id) !== entry) return;
                    if (!err) {
                        this.outbox.delete(id);
                        return;
                    }
                    // broker nack, or the channel closed before confirming - send again later
                    entry.sentGen = -1;
                    if (gen === this.generation) this.scheduleFlush();
                }
            );
            this.logPublish(entry.exchange, entry.key, entry.flag, entry.jMsg, entry.options, "confirm");
        } catch (err: unknown) {
            entry.sentGen = -1;
            warnLogger.warn(`confirm publish failed (${getErrorMessage(err)}), kept in outbox`, {
                title: "RabbitMQ",
                type: "outbox",
                status: { id, key: entry.key }
            });
        }
    }

    private flushOutbox() {
        if (!this.outboxOpen || !this.confirmChannel || this.outbox.size === 0) return;
        let count = 0;
        for (const [id, entry] of this.outbox) {
            // already in flight on the live channel - its confirm callback will settle it
            if (entry.sentGen === this.generation) continue;
            this.sendEntry(id, entry);
            count++;
        }
        if (count) {
            infoLogger.info(`Flushed ${count} outbox messages`, {
                title: "RabbitMQ",
                type: "flush cache"
            });
        }
    }

    private scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushOutbox();
        }, 1000);
    }

    public isOutboxOpen() {
        return this.outboxOpen;
    }

    /** Start delivering reliable messages - call once the QAMS session is settled. */
    public openOutbox() {
        this.outboxOpen = true;
        this.flushOutbox();
    }

    /** Hold reliable messages in the outbox until openOutbox() (session about to change). */
    public closeOutbox() {
        this.outboxOpen = false;
    }

    /** Drop a still-undelivered message whose content has become stale (e.g. reconciled via CH). */
    public discardOutbox(id: string) {
        if (!id || !this.outbox.delete(id)) return;
        infoLogger.info(`discard outbox message ${id}`, {
            title: "RabbitMQ",
            type: "outbox"
        });
    }

    private logPublish(exchange: string, key: string, flag: "REQ" | "RES", jMsg: any, options: PublishOptions, mode: string) {
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
            }
            if (!blackList.includes(jMsg.payload.cmd_id)) {
                rb_transactionLogger.info(`Published [response] message (${jMsg.payload.cmd_id}) to exchange- "${exchange}", routingKey in mode: ${mode}- "${key}"`, {
                    title: "RabbitMQ",
                    type: "publish",
                    response: { ...jMsg.payload, session: jMsg.session }
                });
            }
        }
    }


    public async consumeDynamicTopic() {
        if (!this.channel) return [];

        const tags = await Promise.all([
            this.consume<AllRes>(q2a_ResponseQName, (msg) => {
                // settle any outstanding reqPublishWithAck() regardless of session/forwarding
                // decision below - it's still a legitimate response to our own request.
                this.settlePendingAck(msg);

                if (!this.connectStatus.qams_isConnect) {
                    debugLogger.info("Drop response: QAMS not connected yet", {
                        title: "RabbitMQ",
                        type: "response",
                        status: { session: msg.session }
                    });
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

            this.consume<AllHandshake>(q2a_handshakeQName, (msg) => {
                const checkSession = (msg.session == this.info.session);
                if (!checkSession) {
                    const canPass = this.info.return_code == ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS;
                    if (canPass) this.controlTransactionOutput$.next(msg);
                } else {
                    this.controlTransactionOutput$.next(msg);
                }
            }),

            this.consume<AllIO>(q2a_ioQName, (msg) => {
                if (msg.session !== this.info.session) return;
                this.q2aIoTransactionOutput$.next(msg);
            })
        ]);
        return tags;
    }

    public async consumeFixTopic() {
        await this.consume<REGISTER_RES | CONNECTION_HEATH_RES>(q2a_registerResponseQName, (msg) => {
            if (msg.payload.cmd_id === CMD_ID.REGISTER || msg.payload.cmd_id == CMD_ID.CONNECTION_HEALTH) {
                this.registerResTransactionOutput$.next(msg);
                return;
            }
        });
        await this.consume<HEARTBEAT>(heartbeatPingQName, (msg) => {
            if (!this.connectStatus.qams_isConnect) {
                warnLogger.warn("Drop heartbeat ping: QAMS not connected yet", {
                    title: "RabbitMQ",
                    type: "heartbeat",
                    status: { session: msg.session }
                });
                return;
            }
            if (msg.session !== this.info.session) {
                warnLogger.warn("Drop heartbeat ping: session mismatch", {
                    title: "RabbitMQ",
                    type: "heartbeat",
                    status: { expected: this.info.session, received: msg.session }
                });
                return;
            }
            this.heartbeatOutput$.next(msg);
        }, true)
    }

}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

