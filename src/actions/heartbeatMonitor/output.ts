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

export const AMR_SERVICE_ISCONNECTED = `${PREFIX}/AMR_SERVICE_ISCONNECTED` as const;
export const amrServiceIsConnected = (data: { isConnected: boolean }) => {
    return {
        type: AMR_SERVICE_ISCONNECTED,
        ...data
    }
}



type AllTransaction =
    | typeof sendQAMSDisconnected
    | typeof reconnectQAMS
    | typeof amrServiceIsConnected

export type AllOutput = ReturnType<AllTransaction>;

export type Output<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never