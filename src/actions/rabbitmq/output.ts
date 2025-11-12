const PREFIX = "RABBIT";


export const RB_IS_CONNECTED = `${PREFIX}/RB_IS_CONNECTED` as const;
export const isConnected = (data: {
    isConnected: boolean;
}) => {
    return {
        type: RB_IS_CONNECTED,
        ...data
    }
};

type AllCreator = 
    | typeof isConnected

export type AllOutput = ReturnType<AllCreator>;

export type Output<T extends AllOutput['type'] | AllCreator = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllCreator ? T : never>['type'] }
    ? A
    : never