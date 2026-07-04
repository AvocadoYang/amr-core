const PREFIX = "HEARTBEAT/INPUT";


export const CONNECT_WITH_QAMS = `${PREFIX}/CONNECT_WITH_QAMS` as const;
export const connectWithQAMS = (data: {
    isConnected: boolean
}) => {
    return {
        type: CONNECT_WITH_QAMS,
        ...data
    }
};



export const CONNECT_WITH_AMR_SERVICE = `${PREFIX}/CONNECT_WITH_AMR_SERVICE` as const;
export const connectWithAmrService = (data: {
    isConnected: boolean
}) => {
    return {
        type: CONNECT_WITH_AMR_SERVICE,
        ...data
    }
}

type AllCreator =
    | typeof connectWithQAMS
    | typeof connectWithAmrService


export type ALL_INPUT = ReturnType<AllCreator>;

export type Input<T extends ALL_INPUT['type'] | AllCreator = ALL_INPUT['type'], A extends ALL_INPUT = ALL_INPUT> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllCreator ? T : never>['type'] }
    ? A
    : never