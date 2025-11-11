type BindingInfo = {
    publisher: string,
    name: string,
    queueOpts: {
        durable?: boolean,
        quorm?: boolean,
        exclusive?: boolean
    }
    exchangeOpts: {
        type: "direct" | "fanout" | "topic" | "headers"
        options: {
            durable?: boolean
            autoDelete?: boolean,
        }
    }
}

export const bindingTable: BindingInfo[] = [
    {
        publisher: "AMR_CORE",
        name: "heartbeat",
        queueOpts: { durable: true, exclusive: false, quorm: true },
        exchangeOpts: { type: "fanout", options: { durable: true, autoDelete: true, } }
    }
]