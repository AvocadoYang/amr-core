const PREFIX = "RABBIT_TRANSACTION";


export const HEARTBEAT = `${PREFIX}/HEARTBEAT` as const;
export const heartbeat = (data: {
    heart_beat: number;
}) => {
    return {
        type: HEARTBEAT,
        ...data
    }
};


type AllTransaction = 
    | typeof heartbeat

export type AllOutput = ReturnType<AllTransaction>;

export type Transaction<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never