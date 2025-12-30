const PREFIX = "HEARTBEAT/OUTPUT"


export const QAMS_DISCONNECTED = `${PREFIX}/QAMS_DISCONNECTED` as const;
export const sendQAMSDisconnected = (data: {
    isConnected: boolean;
}) => {
    return {
        type: QAMS_DISCONNECTED,
        ...data
    }
};

export const RECONNECT_QAMS = `${PREFIX}/RECONNECT_QAMS` as const;
export const reconnectQAMS = () => {
    return {
        type: RECONNECT_QAMS
    }
}



type AllTransaction =
    | typeof sendQAMSDisconnected
    | typeof reconnectQAMS

export type AllOutput = ReturnType<AllTransaction>;

export type Output<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never