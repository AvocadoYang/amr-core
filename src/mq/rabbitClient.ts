import * as amqp from "amqplib";
import winston from 'winston';
import { SysLoggerNormal, SysLoggerNormalError, SysLoggerNormalWarning } from "~/logger/systemLogger";
import { filter, interval, Subject, Subscription } from "rxjs";
import config from "~/configs"
import * as faker from 'faker';
import { RabbitLoggerBindingDebug, RabbitLoggerDebug, RabbitLoggerNormalError } from "~/logger/rabbitLogger";
import { Transaction } from "~/actions/rabbitmq/transactions";
import { bindingTable } from "./bindingTable";
import { isConnected, Output } from "~/actions/rabbitmq/output";
import { sendHeartbeat } from "./transactionsWrapper";
import { AllRes } from "./type/res";
import { AllReq } from "./type/req";

export default class RabbitClient {
    private url: string;
    private machineID: string;
    private connection: amqp.ChannelModel | null = null
    private channel: amqp.Channel | null = null;
    private isClosing = false;
    public debugLogger: winston.Logger;
    private bindingLogger: winston.Logger;
    private transactionOutput$: Subject<AllRes | AllReq>;
    private output$: Subject<Output>
    private heartbeat: number = 1;
    private heartbeatSwitch: boolean = false;


    public transactionMap: Map<string, { id: string, timer?: NodeJS.Timeout, count: number }> = new Map();

    private retryTime: number;
    private heartbeat$: Subscription;
    constructor(
        option: { retryTime?: number } = {}
    ) {
        this.transactionOutput$ = new Subject();
        this.output$ = new Subject();
        this.machineID = config.MAC;
        this.debugLogger = RabbitLoggerDebug(false);
        this.bindingLogger = RabbitLoggerBindingDebug(false);
        this.retryTime = option.retryTime ?? 8000
        this.url = `amqp://kenmec:kenmec@${config.MISSION_CONTROL_HOST}:5672`
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
                    SysLoggerNormalWarning.warn("Connection closed. Reconnecting in 8s...", {
                        type: "rabbitmq service"
                    });
                    if(this.heartbeat$ && !this.heartbeat$.closed){
                        this.heartbeat$.unsubscribe();
                    };
                    this.output$.next(isConnected({ isConnected: false}))
                    this.channel = null;
                    setTimeout(() => this.connect(), this.retryTime);
                
            });
            
            this.channel = await this.connection.createChannel();

            SysLoggerNormal.info(`Connected to ${this.url}`, {
                type: "rabbitmq service"
            })
            await this.init();

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

    public sendToReqQueue(queueName: string, message: string) {
        const msg = JSON.stringify({ sender: this.machineID, msg: message, flag: "REQ" });
        // if (!this.channel) throw new Error("Channel is not available");
        if (!this.channel) return;
        this.channel.sendToQueue(queueName, Buffer.from(msg));
        this.debugLogger.info(` Sent message to "${queueName}"`, {
            type: "publish",
            status: JSON.parse(message)
        });
    }

    public sendToResQueue(queueName: string, message: string) {
        const msg = JSON.stringify({ sender: this.machineID, msg: message, flag: "Res" });
        if (!this.channel) throw new Error("Channel is not available");
        this.channel.sendToQueue(queueName, Buffer.from(msg));
        this.debugLogger.info(` Sent message to "${queueName}"`, {
            type: "publish",
            status: JSON.parse(message)
        });
    }

    public async reqPublish(exchangeName: string, routingKey: string, message: string) {
        try {
            const jMsg = { id: faker.datatype.uuid(), sender: this.machineID, flag: "REQ", msg: message }
            const sMsg = JSON.stringify(jMsg);
            if (!this.channel) throw new Error("Rabbit channel is not available");
            this.channel.publish(exchangeName, routingKey, Buffer.from(sMsg), {
                expiration: "10000"
            });
            this.transactionMap.set(jMsg.id, { id: jMsg.id, count: 0 });
            this.debugLogger.info(`Published message to exchange "${exchangeName}"`, {
                type: "publish",
                status: JSON.parse(message)
            });

        } catch (err) {
            RabbitLoggerNormalError.error(`${err.message}`, {
                type: "rabbitmq service"
            })
        }
    }

    public async resPublish(exchangeName: string, routingKey: string, message: string) {
        try {
            const msg = JSON.stringify({ sender: this.machineID, flag: "RES", msg: message });
            if (!this.channel) throw new Error("Rabbit channel is not available");
            this.channel.publish(exchangeName, routingKey, Buffer.from(msg), {
                expiration: "10000"
            });

            this.debugLogger.info(`Published message to exchange "${exchangeName}"`, {
                type: "publish",
                status: JSON.parse(message)
            });

        } catch (err) {
            RabbitLoggerNormalError.error(`${err.message}`, {
                type: "rabbitmq service"
            })
        }
    }

    public setTransactionTimmer(msg: { id: string, sender: string, flag: "REQ" | "RES", msg: string }) {
        try {
            const existing = this.transactionMap.get(msg.id);
            const count = existing ? 0 : 1;
        } catch (err) {

        }
    }

    public async consume<A>(queueName: string, onMessage: (msg: A ) => void) {
        if (!this.channel) throw new Error("Channel is not available");
        await this.channel.consume(queueName, (msg) => {
            if (msg) {
                try {
                    const content = msg.content.toString();
                    const data = JSON.parse(content);
                        if (data.flag == 'RES') {
                            this.debugLogger.info(`Receive response message`, {
                                type: "receive",
                                status: JSON.parse(data.msg)
                            })
                        } else {
                            this.debugLogger.info(`Receive request message`, {
                                type: "receive",
                                status: JSON.parse(data.msg)
                            });
                        }

                        onMessage({flag: data.flag, ...JSON.parse(data.msg)});
                } catch (err) {
                    RabbitLoggerNormalError.error("Failed to parse message", {
                        type: "parse error",
                        status: err
                    })
                } finally {
                    this.channel!.ack(msg);
                }
            }
        });
    }

    public async init() {
        bindingTable.forEach(async( info) =>{
            const { queueOpts, exchangeOpts, name, publisher } = info;
            for(let flag of ["REQ", "RES"]){
                const q = await this.createQueue(
                    `${name}/${config.MAC}/${flag}`,
                    queueOpts
                )
            };
            switch(publisher){
                case "QAMS":
                    await this.consume(`${name}/${config.MAC}/REQ`,(data: AllReq)=>{
                        this.transactionOutput$.next(data)
                    });
                    break;
                case "AMR_CORE":
                    await this.consume(`${name}/${config.MAC}/RES`,(data: AllRes)=>{
                        this.transactionOutput$.next(data)
                    })
            };
            if(name == "heartbeat"){
                this.heartbeat$ = interval(5000).pipe(filter(() => this.heartbeatSwitch)).subscribe(() => {
                    this.heartbeat += 1;
                    if(this.heartbeat > 9999) this.heartbeat = 1;
                    this.sendToReqQueue(`${name}/${config.MAC}/REQ`, sendHeartbeat(this.heartbeat));
                })
            }
        });
        this.output$.next(isConnected({ isConnected: true}));

    }


    public onTransaction(cb: (action: AllReq | AllRes ) => void) {
        return this.transactionOutput$.subscribe(cb);
    }

    public subscribe(cb: (action: Output) => void){
        return this.output$.subscribe(cb);
    }

    public switchHeartbeat(isOpen: boolean){
        this.heartbeatSwitch = isOpen
    }



    public async close() {
        this.isClosing = true;
        await this.channel?.close();
        await this.connection?.close();

        SysLoggerNormal.info(`Connection closed manually.`, {
            type: "rabbitmq service"
        })

    }
}
