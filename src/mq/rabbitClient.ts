import * as amqp from "amqplib";
import winston from 'winston';
import { SysLoggerNormal, SysLoggerNormalError, SysLoggerNormalWarning } from "~/logger/systemLogger";
import { BehaviorSubject, combineLatest, defer, distinctUntilChanged, distinctUntilKeyChanged, EMPTY, filter, finalize, from, interval, map, merge, NEVER, startWith, Subject, Subscription, switchMap, tap } from "rxjs";
import config from "~/configs"
import * as faker from 'faker';
import { RabbitLoggerBindingDebug, RabbitLoggerDebug, RabbitLoggerNormal, RabbitLoggerNormalError, RabbitLoggerNormalWarning } from "~/logger/rabbitLogger";
import { Transaction } from "~/actions/rabbitmq/transactions";
import { bindingTable } from "./bindingTable";
import { isConnected, Output } from "~/actions/rabbitmq/output";
import { RequestMsgType, ResponseMsgType, sendHeartbeat } from "./transactionsWrapper";
import { AllRes } from "./type/res";
import { AllReq, HEARTBEAT } from "./type/req";
import { CMD_ID } from "./type/cmdId";
import { REQ_EX, RES_EX, IO_EX, CONTROL_EX, HANDSHAKE_IO_QUEUE, PublishOptions, volatile, controlQName, ioQFromQAMS, reqQName, responseQName, HEARTBEAT_EX, heartbeatPingQName, heartbeatPongQName } from "./type/type";
import { AllControl } from "./type/control";
import { formatDate } from "~/helpers/system";
import { AllIO } from "./type/ioFromQams";
import { Input } from "~/actions/rabbitmq/input";
import { ReturnCode } from "./type/returnCode";

export default class RabbitClient {
    private url: string;
    private isInit: boolean = false;
    private machineID: string;
    private connection: amqp.ChannelModel | null = null
    private channel: amqp.Channel | null = null;
    private isClosing = false;
    public debugLogger: winston.Logger;
    private bindingLogger: winston.Logger;
    private heartbeatOutput$: Subject<HEARTBEAT> = new Subject();
    private resTransactionOutput$: Subject<AllRes> = new Subject();
    private reqTransactionOutput$: Subject<AllReq> = new Subject();
    private ioTransactionOutput$: Subject<AllIO> = new Subject();
    private controlTransactionOutput$: Subject<AllControl> = new Subject();

    private consumerTags: string[] = [];

    private rabbitIsConnected$ = new BehaviorSubject<boolean>(false);
    private output$: Subject<Output>
    public input$: Subject<Input>

    private controlCache: { timestamp: number, type: "CONTROL", msg: AllControl }[] = [];
    private requestCache: { timestamp: number, type: "REQUEST", msg: AllReq }[] = [];
    private responseCache: { timestamp: number, type: "RESPONSE", msg: AllRes }[] = [];
    private ioCache: { timestamp: number, type: "IO", msg: AllIO }[] = [];

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
        private info: { amrId: string, isConnect: boolean, session: string, return_code: string },
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
                filter((action) => action.type == "RABBIT/INPUT/RB_IS_CONNECTED"),
                map((data) => data.isConnected), startWith(false)
            ),
            this.rabbitIsConnected$.pipe(startWith(false))
        ]).pipe(
            distinctUntilChanged((prev, curr) => prev[0] === curr[0] && prev[1] === curr[1]),
            switchMap(([serviceConnected, rabbitConnected]) => {
                if (serviceConnected && rabbitConnected) {
                    return defer(() => {
                        RabbitLoggerNormal.info("Start consuming topics", { type: "consume" });
                        return from(this.consumeTopic());
                    }).pipe(
                        switchMap(() => NEVER),
                        finalize(() => {
                            RabbitLoggerNormal.info("Stop consuming topics", {
                                type: "consume"
                            });
                            if (serviceConnected) this.cancelConsumers();
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
                this.rabbitIsConnected$.next(false);
            });

            this.connection.on("close", () => {
                SysLoggerNormalWarning.warn("Connection closed. Reconnecting in 3s...", {
                    type: "rabbitmq service"
                });

                this.output$.next(isConnected({ isConnected: false }))
                this.channel = null;
                this.rabbitIsConnected$.next(false);
                setTimeout(() => this.connect(), this.retryTime);

            });

            this.channel = await this.connection.createChannel();

            SysLoggerNormal.info(`Connected to ${this.url}`, {
                type: "rabbitmq service"
            });
            this.rabbitIsConnected$.next(true)

        } catch (err) {
            SysLoggerNormalError.error("Connection failed", {
                type: "rabbitmq service",
                status: (err as Error).message
            });
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
            if (!this.info.isConnect) return;
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

    public async consume<A>(queueName: string, onMessage: (msg: A) => void) {
        if (!this.channel) throw new Error("Channel is not available");
        const localChannel = this.channel;
        const consumeTag = await this.channel.consume(queueName, (msg) => {
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
                        localChannel.ack(msg);  // 用舊 channel ack，而非 this.channel!!!
                    } catch (e) {
                        console.error("ack failed:", e);
                    }
                }
            }
        });

        return consumeTag.consumerTag;
    }

    public async init() {


        await this.createExchange(HEARTBEAT_EX, "topic", { durable: true });
        await this.createExchange(REQ_EX, "topic", { durable: true });
        await this.createExchange(RES_EX, "topic", { durable: true });
        await this.createExchange(IO_EX, "topic", { durable: true });
        await this.createExchange(CONTROL_EX, "topic", { durable: true });


        await this.createQueue(ioQFromQAMS, { durable: true });
        await this.bindQueue(ioQFromQAMS, IO_EX, `amr.${config.MAC}.io.from.qams.*`);



        await this.createQueue(reqQName, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await this.bindQueue(reqQName, REQ_EX, `amr.${config.MAC}.req.*`);


        await this.createQueue(controlQName, { durable: true, arguments: { "x-queue-type": "quorum" } });
        await this.bindQueue(controlQName, CONTROL_EX, `amr.${config.MAC}.control.*`);



        await this.createQueue(responseQName, { durable: true });
        await this.bindQueue(responseQName, RES_EX, `amr.${config.MAC}.*.res`);


        await this.createQueue(heartbeatPingQName, { autoDelete: false });
        await this.createQueue(heartbeatPongQName, { autoDelete: false });
        await this.bindQueue(heartbeatPingQName, HEARTBEAT_EX, `amr.heartbeat.ping.${config.MAC}`);
        await this.bindQueue(heartbeatPongQName, HEARTBEAT_EX, `amr.heartbeat.pong.${config.MAC}`);

        this.output$.next(isConnected({ isConnected: true }));
    }

    public onHeartbeat(cb: (action: HEARTBEAT) => void) {
        return this.heartbeatOutput$.subscribe(cb);
    }

    public onReqTransaction(cb: (action: AllReq) => void) {
        return this.reqTransactionOutput$.subscribe(cb);
    }


    public onResTransaction(cb: (action: AllRes) => void) {
        return this.resTransactionOutput$.subscribe(cb);
    }

    public onControlTransaction(cb: (action: AllControl) => void) {
        return this.controlTransactionOutput$.subscribe(cb);
    }

    public onIOTransaction(cb: (action: AllIO) => void) {
        return this.ioTransactionOutput$.subscribe(cb)
    }

    public subscribe(cb: (action: Output) => void) {
        return this.output$.subscribe(cb);
    }


    public async close() {
        this.isClosing = true;
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

    public flushCache(data: { continue: boolean }) {
        const { continue: isSync } = data;
        RabbitLoggerNormal.info("flush cache", {
            type: "cache",
            status: { isSync }
        })
        if (isSync) {
            const msg = [...this.controlCache, ...this.requestCache, ...this.responseCache, ...this.ioCache.slice(-30)]
                .flat()
                .sort((a, b) => a.timestamp - b.timestamp);
            msg.forEach((data) => {
                switch (data.type) {
                    case "CONTROL":
                        this.controlTransactionOutput$.next(data.msg);
                        break;
                    case "REQUEST":
                        this.reqTransactionOutput$.next(data.msg);
                        break;
                    case "RESPONSE":
                        this.resTransactionOutput$.next(data.msg);
                        break;
                }
            });
        }

        this.controlCache.length = 0;
        this.requestCache.length = 0;
        this.responseCache.length = 0;
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
        if (!this.isInit) {
            await this.init();
            this.isInit = true;
            await this.flushPendingMessages();
        }
        const tags = await Promise.all([
            this.consume<HEARTBEAT>(heartbeatPingQName, (msg) => {
                if (msg.session !== this.info.session) return;
                this.heartbeatOutput$.next(msg);
            }),
            this.consume<AllControl>(controlQName, (msg) => {
                const checkSession = msg.session == this.info.session;
                if (!checkSession) {
                    const canPass = this.info.return_code == ReturnCode.SUCCESS;
                    if (canPass) this.controlTransactionOutput$.next(msg);
                } else {
                    this.controlTransactionOutput$.next(msg);
                }
            }),

            this.consume<AllReq>(reqQName, (msg) => {
                const checkSession = msg.session == this.info.session;
                if (!checkSession) {
                    const canPass = this.info.return_code == ReturnCode.SUCCESS;
                    if (canPass) this.reqTransactionOutput$.next(msg);
                } else {
                    this.reqTransactionOutput$.next(msg);
                }
            }),

            this.consume<AllIO>(ioQFromQAMS, (msg) => {
                const checkSession = msg.session == this.info.session;
                if (!checkSession) {
                    return;
                } else {
                    this.ioTransactionOutput$.next(msg);
                }
            }),

            this.consume<AllRes>(responseQName, (msg) => {
                const checkSession = msg.session == this.info.session;
                if (!checkSession) {
                    const canPass = this.info.return_code == ReturnCode.SUCCESS;
                    if (canPass) this.resTransactionOutput$.next(msg);
                } else {
                    this.resTransactionOutput$.next(msg);
                };
            })
        ]);
        this.consumerTags = tags;
        return tags;
    }

    private async cancelConsumers() {
        if (!this.channel) return;
        for (const tag of this.consumerTags) {
            try {
                await this.channel.cancel(tag);
            } catch (e) {
                // channel 可能已經 close，忽略
            }
        }
        this.consumerTags = [];
    }

}
