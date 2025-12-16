const PREFIX = "RABBIT/INPUT";


export const CONNECT_WITH_QAMS = `${PREFIX}/RB_IS_CONNECTED` as const;
export const connectWithQAMS = (data: {
    isConnected: boolean
}) => {
    return {
        type: CONNECT_WITH_QAMS,
        ...data
    }
};

type AllCreator =
    | typeof connectWithQAMS

export type ALL_INPUT = ReturnType<AllCreator>;

export type Input<T extends ALL_INPUT['type'] | AllCreator = ALL_INPUT['type'], A extends ALL_INPUT = ALL_INPUT> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllCreator ? T : never>['type'] }
    ? A
    : never