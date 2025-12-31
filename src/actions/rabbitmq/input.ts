const PREFIX = "RABBIT/INPUT";


export const CONNECT_WITH_QAMS = `${PREFIX}/QAMS_IS_CONNECTED` as const;
export const connectWithQAMS = (data: {
    isConnected: boolean
}) => {
    return {
        type: CONNECT_WITH_QAMS,
        ...data
    }
};



export const CONNECT_WITH_ROS_BRIDGE = `${PREFIX}/CONNECT_WITH_ROS_BRIDGE` as const;
export const connectWithRosBridge = (data: {
    isConnected: boolean
}) => {
    return {
        type: CONNECT_WITH_ROS_BRIDGE,
        ...data
    }
}

export const AMR_SERVICE_ISCONNECTED = `${PREFIX}/AMR_SERVICE_ISCONNECTED` as const;
export const sendAmrServiceIsConnected = (data: { isConnected: boolean }) => {
    return {
        type: AMR_SERVICE_ISCONNECTED,
        ...data
    }
}

type AllCreator =
    | typeof connectWithQAMS
    | typeof connectWithRosBridge
    | typeof sendAmrServiceIsConnected


export type ALL_INPUT = ReturnType<AllCreator>;

export type Input<T extends ALL_INPUT['type'] | AllCreator = ALL_INPUT['type'], A extends ALL_INPUT = ALL_INPUT> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllCreator ? T : never>['type'] }
    ? A
    : never