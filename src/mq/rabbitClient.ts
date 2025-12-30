import * as amqp from "amqplib";
import winston from 'winston';
import { SysLoggerNormal, SysLoggerNormalError, SysLoggerNormalWarning } from "~/logger/systemLogger";
import { BehaviorSubject, combineLatest, defer, distinctUntilChanged, EMPTY, filter, finalize, from, map, NEVER, startWith, Subject, switchMap } from "rxjs";
import config from "~/configs"
import * as faker from 'faker';
import { RabbitLoggerBindingDebug, RabbitLoggerDebug, RabbitLoggerNormal, RabbitLoggerNormalError, RabbitLoggerNormalWarning } from "~/logger/rabbitLogger";
import { isConnected, Output } from "~/actions/rabbitmq/output";
import { RequestMsgType, ResponseMsgType } from "./transactionsWrapper";
import { AllRes } from "./type/res";
import { RES_EX, IO_EX, CONTROL_EX, PublishOptions, volatile, HEARTBEAT_EX, heartbeatPingQName, q2a_controlQName, q2a_amrResponseQName, a2q_handshakeQName, a2q_qamsResponseQName, dynamicListener, HEARTBEAT_PONG_QUEUE } from "./type/type";
import { AllControl, HEARTBEAT } from "./type/control";
import { formatDate } from "~/helpers/system";
import { CONNECT_WITH_QAMS, CONNECT_WITH_ROS_BRIDGE, Input } from "~/actions/rabbitmq/input";
import { ReturnCode } from "./type/returnCode";
import { TRANSACTION_INFO } from "~/types/status";

export default class RabbitClient {
    private url: string;
    private machineID: string;
    private connection: amqp.ChannelModel | null = null
    private channel: amqp.Channel | null = null;
    public debugLogger: winston.Logger;
    private bindingLogger: winston.Logger;
    private heartbeatOutput$: Subject<HEARTBEAT> = new Subject();
    private resTransactionOutput$: Subject<AllRes> = new Subject();
    private controlTransactionOutput$: Subject<AllControl> = new Subject();

    private error_logger_switch: boolean = true;

    private rabbitIsConnected$ = new BehaviorSubject<boolean>(false);
    private output$: Subject<Output>
    public input$: Subject<Input>

    private pendingMessages: {
        exchange: string;
        key: string;
        buffer: Buffer;
        options: PublishOptions;
        flag: "REQ" | "RES"
    }[] = [];


    public transactionMap: Map<string, { id: string, count: number }> = new Map();

    private retryTime: number;
    constructor(
        private info: TRANSACTION_INFO,
        private consumedQueues: Map<string, string>,
        option: { retryTime?: number } = {}
    ) {
        this.output$ = new Subject();
        this.input$ = new Subject();
        this.machineID = config.MAC;
        this.debugLogger = RabbitLoggerDebug(false);
        this.bindingLogger = RabbitLoggerBindingDebug(false);
        this.retryTime = option.retryTime ?? 3000
        this.url = `amqp://kenmec:kenmec@${config.RABBIT_MQ_HOST}:5672`

        combineLatest([
            this.input$.pipe(
                filter((action) => action.type == CONNECT_WITH_QAMS),
                map((data) => data.isConnected), startWith(false)
            ),
            this.rabbitIsConnected$.pipe(startWith(false)),
            this.input$.pipe(
                filter((action) => action.type == CONNECT_WITH_ROS_BRIDGE),
                map((data) => data.isConnected), startWith(false)
            ),
        ]).pipe(
            distinctUntilChanged((prev, curr) => {
                return (prev[0] === curr[0]) && (prev[1] === curr[1]) && (prev[2] === curr[2]);
            }),
            switchMap(([serviceConnected, rabbitConnected, rosbridgeConnected]) => {
                if (serviceConnected && rabbitConnected && rosbridgeConnected) {
                    return defer(() => {
                        RabbitLoggerNormal.info("Start consuming topics", { type: "consume" });
                        return from(this.consumeTopic());
                    }).pipe(
                        switchMap(() => NEVER),
                        finalize(() => {
                            RabbitLoggerNormal.info("Stop consuming topics", {
                                type: "consume"
                            });
                            this.stopConsumeQueue(dynamicListener)
                        })
                    );
                };
                RabbitLoggerNormal.info("connection status", {
                    type: "connect", status: {
                        rabbitService: rabbitConnected,
                        qamsService: serviceConnected
                    }
                })
                return EMPTY;
            })
        ).subscribe();

    }

    public async connect() {
        try {
            this.connection = await amqp.connect(this.url);
            this.connection.on("error", (err) => {
                SysLoggerNormalError.error("Connection error", {
                    type: "rabbitmq service",
                    status: err.message
                });
                this.channel = null;
                this.output$.next(isConnected({ isConnected: false }))
            });

            this.connection.on("close", () => {
                SysLoggerNormalWarning.warn("Connection closed. Reconnecting in 3s...", {
                    type: "rabbitmq service"
                });

                this.channel = null;
                this.consumedQueues.clear();
                this.output$.next(isConnected({ isConnected: false }))
                setTimeout(() => this.connect(), this.retryTime);

            });

            this.channel = await this.connection.createChannel();

            SysLoggerNormal.info(`Connected to ${this.url}`, {
                type: "rabbitmq service"
            });

            this.error_logger_switch = true;
            await this.init();
            this.rabbitIsConnected$.next(true);
            this.output$.next(isConnected({ isConnected: true }))

        } catch (err) {
            if (this.error_logger_switch) {
                SysLoggerNormalError.error("Connection failed", {
                    type: "rabbitmq service",
                    status: (err as Error).message
                });
                this.error_logger_switch = false;
            }
            setTimeout(() => this.connect(), this.retryTime);
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
        this.bindingLogger.info(` Queue "${queueName}" is ready. Options`, {
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

        this.bindingLogger.info(`Exchange "${exchangeName}" is ready.`, {
            type: "exchange setting",
            status: { type, ...exchangeOptions }
        });
        return exchange;
    }


    private async bindQueue(queueName: string, exchangeName: string, pattern = "") {
        if (!this.channel) throw new Error("Channel is not available");
        await this.channel.bindQueue(queueName, exchangeName, pattern);

        this.bindingLogger.info(`Queue "${queueName}" bound to exchange "${exchangeName}"`, {
            type: "bind",
            status: { queue: queueName, exchange: exchangeName, pattern }
        });
    }

    public sendToReqQueue(queueName: string, message: string, cmd_id: string) {
        const msg = JSON.stringify({ sender: this.machineID, msg: message, flag: "REQ" });
        // if (!this.channel) throw new Error("Channel is not available");
        if (!this.channel) return;
        this.channel.sendToQueue(queueName, Buffer.from(msg));
        this.debugLogger.info(` send message ${cmd_id} to "${queueName}" -`, {
            type: "publish",
            status: JSON.parse(message)
        });
    }

    public sendToResQueue(queueName: string, message: string, cmd_id: string) {
        const msg = JSON.stringify({ sender: this.machineID, msg: message, flag: "RES" });
        if (!this.channel) throw new Error("Channel is not available");
        this.channel.sendToQueue(queueName, Buffer.from(msg));
        this.debugLogger.info(` send message ${cmd_id} to "${queueName}" -`, {
            type: "publish",
            status: JSON.parse(message)
        });
    }

    public async reqPublish(
        exchangeName: string,
        routingKey: string,
        message: RequestMsgType,
        options?: PublishOptions
    ) {
        const id = faker.datatype.uuid();
        const flag = "REQ";
        const jMsg = {
            id,
            sender: "AMR_CORE",
            serialNum: this.machineID,
            session: this.info.session,
            flag,
            timestamp: formatDate(),
            payload: { id, ...message, amrId: this.info.amrId }
        };

        const sMsg = JSON.stringify(jMsg);
        const buffer = Buffer.from(sMsg);

        try {
            await this.publishWithRetry(exchangeName, routingKey, buffer, flag);

            // 發送成功才記錄 transaction
            this.transactionMap.set(id, { id, count: 0 });

            this.debugLogger.info(`Published REQ`, {
                type: "publish",
                status: message
            });

        } catch (err) {
            RabbitLoggerNormalError.error(`${err.message}`, {
                type: "rabbitmq service"
            });
        }
    }

    public async resPublish(
        exchangeName: string,
        routingKey: string,
        message: ResponseMsgType,
        options?: PublishOptions
    ) {
        const flag = "RES";
        const sMsg = JSON.stringify({
            id: message.id,
            sender: "AMR_CORE",
            serialNum: this.machineID,
            session: this.info.session,
            flag,
            timestamp: formatDate(),
            payload: message
        });


        const buffer = Buffer.from(sMsg);

        try {
            await this.publishWithRetry(exchangeName, routingKey, buffer, flag, options);

            this.debugLogger.info(`Published RES`, {
                type: "publish",
                status: message
            });

        } catch (err) {
            RabbitLoggerNormalError.error(`${err.message}`, {
                type: "rabbitmq service"
            });
        }
    }


    public setTransactionTimmer(msg: { id: string, sender: string, flag: "REQ" | "RES", msg: string }) {
        try {
            const existing = this.transactionMap.get(msg.id);
            const count = existing ? 0 : 1;
        } catch (err) {

        }
    }

    public async consume<A>(queueName: string, onMessage: (msg: A) => void, noAck = false) {
        if (!this.channel) throw new Error("Channel is not available");
        const localChannel = this.channel;
        if (this.consumedQueues.has(queueName)) {
            RabbitLoggerNormal.info(`Queue ${queueName} already being consumed.`, {
                type: "consume queue"
            });
            return this.consumedQueues.get(queueName);
        } else {
            RabbitLoggerNormal.info(`start consume queue: ${queueName}`, {
                type: "consume queue",
            });
        }
        const consumer = await this.channel.consume(queueName, (msg) => {
            if (msg) {
                try {
                    const content = msg.content.toString();
                    const data = JSON.parse(content);
                    const { payload } = data;
                    if (data.flag == 'RES') {
                        this.debugLogger.info(`Receive response message`, {
                            type: "receive",
                            status: payload
                        })
                    } else {
                        this.debugLogger.info(`Receive request message`, {
                            type: "receive",
                            status: payload
                        });
                    }

                    onMessage(data);

                } catch (err) {
                    RabbitLoggerNormalError.error("Failed to parse message", {
                        type: "parse error",
                        status: err
                    })
                } finally {
                    try {
                        if (!noAck) localChannel.ack(msg);  // 用舊 channel ack，而非 this.channel!!!
                    } catch (e) {
                        console.error("ack failed:", e);
                    }
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

        await this.createQueue(q2a_controlQName, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await this.bindQueue(q2a_controlQName, CONTROL_EX, `amr.${config.MAC}.control.*`);

        await this.createQueue(q2a_amrResponseQName, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await this.bindQueue(q2a_amrResponseQName, RES_EX, `amr.${config.MAC}.*.res`);

        await this.createQueue(a2q_handshakeQName, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await this.bindQueue(a2q_handshakeQName, CONTROL_EX, `qams.${config.MAC}.handshake.*`);

        await this.createQueue(a2q_qamsResponseQName, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await this.bindQueue(a2q_qamsResponseQName, RES_EX, `qams.${config.MAC}.res.*`);

        await this.createQueue(HEARTBEAT_PONG_QUEUE, { durable: true });
        await this.bindQueue(HEARTBEAT_PONG_QUEUE, HEARTBEAT_EX, `qams.heartbeat.pong.*`);

        await this.createQueue(heartbeatPingQName, { autoDelete: false });
        await this.bindQueue(heartbeatPingQName, HEARTBEAT_EX, `amr.heartbeat.ping.${config.MAC}`);
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
        await this.channel?.close();
        await this.connection?.close();

        SysLoggerNormal.info(`Connection closed manually.`, {
            type: "rabbitmq service"
        })
    }

    private isVolatile(exchange: string, routingKey: string): boolean {
        if (exchange !== IO_EX && !exchange.includes("heartbeat")) return false;

        return volatile.some(v => routingKey.includes(v));
    }

    private async publishWithRetry(
        exchange: string,
        key: string,
        buffer: Buffer,
        flag: "REQ" | "RES",
        options: PublishOptions = {}
    ): Promise<void> {

        const {
            expiration,
            retries = 3,
            retryDelay = 3000,
        } = options;

        let attempts = 0;

        while (attempts < retries) {
            try {
                if (!this.channel) throw new Error("Rabbit channel is not available");
                const publishOptions = expiration
                    ? { expiration }
                    : undefined;
                this.channel.publish(exchange, key, buffer, publishOptions);

                return;
            } catch (err) {
                if (this.isVolatile(exchange, key)) {
                    return;
                }
                attempts++;

                if (attempts >= retries) {
                    const data = JSON.parse(buffer.toString());
                    RabbitLoggerNormalWarning.warn(`Failed to publish after ${attempts} attempts: ${err.message}, store message to pending queue`, {
                        type: "transaction",
                        message: { exchange, key, data }
                    });
                    this.pendingMessages.push({ exchange, key, buffer, flag, options });
                    return;
                }

                await new Promise((r) => setTimeout(r, retryDelay));
            }
        }
    }


    private async flushPendingMessages() {
        if (!this.channel || this.pendingMessages.length === 0) return;

        SysLoggerNormal.info(`Flushing ${this.pendingMessages.length} pending messages...`, {
            type: "rabbitmq service"
        });

        const messages = [...this.pendingMessages];
        this.pendingMessages = []; // 先清空避免重複送

        for (const msg of messages) {
            try {
                await this.publishWithRetry(
                    msg.exchange,
                    msg.key,
                    msg.buffer,
                    msg.flag,
                    msg.options
                );
            } catch (err) {
                // 如果 flush 時仍然失敗，先放回 pending
                this.pendingMessages.push(msg);
            }
        }
    }

    public send(action: Input) {
        this.input$.next(action);
    }


    private async consumeTopic() {
        if (!this.channel) return [];

        const tags = await Promise.all([
            this.consume<HEARTBEAT>(heartbeatPingQName, (msg) => {
                if (msg.session !== this.info.session) return;
                this.heartbeatOutput$.next(msg);
            }, true),

            this.consume<AllControl>(q2a_controlQName, (msg) => {
                this.controlTransactionOutput$.next(msg);

            }),

            this.consume<AllRes>(q2a_amrResponseQName, (msg) => {
                const checkSession = (msg.session == this.info.session);
                if (!checkSession) {
                    const canPass = this.info.return_code == ReturnCode.SUCCESS;
                    if (canPass) this.resTransactionOutput$.next(msg);
                } else {
                    this.resTransactionOutput$.next(msg);
                };
            })
        ]);
        await this.flushPendingMessages();

        return tags;
    }

    public async stopConsumeQueue(queueNames: string[] = []) {
        if (!this.channel) return;
        for (const queueName of queueNames) {
            if (!this.consumedQueues.has(queueName)) continue;
            try {
                const tag = this.consumedQueues.get(queueName);
                await this.channel.cancel(tag);
                this.consumedQueues.delete(queueName);
                RabbitLoggerNormal.info(` stop consume queue: ${queueName}`, {
                    type: "stop consume",
                });
            } catch (e) {
                // channel 可能已經 close，忽略
            }
        }
    }


}
