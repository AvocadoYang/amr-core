import * as amqp from "amqplib";
import winston from 'winston';
import { SysLoggerNormal, SysLoggerNormalError, SysLoggerNormalWarning } from "~/logger/systemLogger";
import { filter, interval, Subject, Subscription } from "rxjs";
import config from "~/configs"
import * as faker from 'faker';
import { RabbitLoggerBindingDebug, RabbitLoggerDebug, RabbitLoggerNormal, RabbitLoggerNormalError, RabbitLoggerNormalWarning } from "~/logger/rabbitLogger";
import { Transaction } from "~/actions/rabbitmq/transactions";
import { bindingTable } from "./bindingTable";
import { isConnected, Output } from "~/actions/rabbitmq/output";
import { RequestMsgType, ResponseMsgType, sendHeartbeat } from "./transactionsWrapper";
import { AllRes } from "./type/res";
import { AllReq } from "./type/req";
import { CMD_ID } from "./type/cmdId";
import { REQ_EX, RES_EX, IO_EX, CONTROL_EX, HANDSHAKE_IO_QUEUE, PublishOptions, volatile } from "./type/type";
import { AllControl } from "./type/control";
import { formatDate } from "~/helpers/system";

export default class RabbitClient {
    private url: string;
    private machineID: string;
    private connection: amqp.ChannelModel | null = null
    private channel: amqp.Channel | null = null;
    private isClosing = false;
    public debugLogger: winston.Logger;
    private bindingLogger: winston.Logger;
    private resTransactionOutput$: Subject<AllRes> = new Subject();
    private reqTransactionOutput$: Subject<AllReq> = new Subject();
    private controlTransactionOutput$: Subject<AllControl> = new Subject();
    private output$: Subject<Output>

    private controlCache: { timestamp: number, type: "CONTROL", msg: AllControl }[] = [];
    private requestCache: { timestamp: number, type: "REQUEST", msg: AllReq }[] = [];
    private responseCache: { timestamp: number, type: "RESPONSE", msg: AllRes }[] = [];

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
        private info: { amrId: string, isConnect: boolean },
        option: { retryTime?: number } = {}
    ) {
        this.output$ = new Subject();
        this.machineID = config.MAC;
        this.debugLogger = RabbitLoggerDebug(false);
        this.bindingLogger = RabbitLoggerBindingDebug(false);
        this.retryTime = option.retryTime ?? 3000
        this.url = `amqp://kenmec:kenmec@${config.RABBIT_MQ_HOST}:5672`

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
            });

            this.connection.on("close", () => {
                SysLoggerNormalWarning.warn("Connection closed. Reconnecting in 3s...", {
                    type: "rabbitmq service"
                });

                this.output$.next(isConnected({ isConnected: false }))
                this.channel = null;
                setTimeout(() => this.connect(), this.retryTime);

            });

            this.channel = await this.connection.createChannel();

            SysLoggerNormal.info(`Connected to ${this.url}`, {
                type: "rabbitmq service"
            })
            await this.init();
            await this.flushPendingMessages();

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
        options: { durable?: boolean; quorum?: boolean; exclusive?: boolean; arguments?: any } = {}
    ) {
        if (!this.channel) throw new Error("Channel is not available");
        const queueOptions: amqp.Options.AssertQueue = {
            durable: options.durable ?? true,
            exclusive: options.exclusive ?? false,
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
        await this.channel.consume(queueName, (msg) => {
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
    }

    public async init() {
        await this.createExchange(REQ_EX, "topic", { durable: true });
        await this.createExchange(RES_EX, "topic", { durable: true });
        await this.createExchange(IO_EX, "topic", { durable: true });
        await this.createExchange(CONTROL_EX, "topic", { durable: true });


        const reqQName = `amr.${config.MAC}.req.queue`;
        await this.createQueue(reqQName, { durable: true });
        await this.bindQueue(reqQName, REQ_EX, `amr.${config.MAC}.req.*`);

        const controlQName = `amr.${config.MAC}.control.queue`;
        await this.createQueue(controlQName, { durable: true });
        await this.bindQueue(controlQName, CONTROL_EX, `amr.${config.MAC}.control.*`);

        await this.createQueue(HANDSHAKE_IO_QUEUE, { durable: true });

        const responseQName = `amr.${config.MAC}.message.res.queue`;
        await this.createQueue(responseQName, { durable: true });
        await this.bindQueue(responseQName, RES_EX, `amr.${config.MAC}.*.res`);


        this.consume<AllControl>(controlQName, (msg) => {
            if (!this.info.isConnect) {
                this.controlCache.push({ timestamp: Date.now(), type: "CONTROL", msg });
            } else {
                this.controlTransactionOutput$.next(msg);
            }
        });

        this.consume<AllReq>(reqQName, (msg) => {
            if (!this.info.isConnect) {
                this.requestCache.push({ timestamp: Date.now(), type: "REQUEST", msg });
            } else {
                this.reqTransactionOutput$.next(msg);

            }
        })

        this.consume<AllRes>(responseQName, (msg) => {
            if (!this.info.isConnect) {
                this.responseCache.push({ timestamp: Date.now(), type: "RESPONSE", msg })
            } else {
                this.resTransactionOutput$.next(msg);
            }
        })

        this.output$.next(isConnected({ isConnected: true }));
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
        if (exchange !== IO_EX) return false;

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

    public flushCache(isSync: boolean) {
        RabbitLoggerNormal.info("flush cache", {
            type: "cache",
            status: { isSync }
        })
        if (isSync) {
            const msg = [...this.controlCache, ...this.requestCache, ...this.responseCache]
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
}
