const PREFIX = "NETWORK_MANAGER";


export const IS_CONNECTED = `${PREFIX}/HEARTBEAT` as const;
export const isConnected = (data: {
    isConnected: boolean;
    amrId: string;
    session: string,
    qamsSerialNum: string;
    return_code: string
}) => {
    return {
        type: IS_CONNECTED,
        ...data
    }
};

export const ROS_BRIDGE_CONNECTED = `${PREFIX}/ROS_BRIDGE_CONNECTED` as const;
export const ros_bridge_connected = (data: {
    isConnected: boolean;
}) => {
    return {
        type: ROS_BRIDGE_CONNECTED,
        ...data
    }
}


type AllTransaction =
    | typeof isConnected
    | typeof ros_bridge_connected

export type AllOutput = ReturnType<AllTransaction>;

export type Output<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never