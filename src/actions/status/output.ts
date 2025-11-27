const PREFIX = "STATUS_MANAGER";


export const IS_REGISTERED = `${PREFIX}/IS_REGISTERED` as const;
export const setIsRegistered = (data: {
    isRegistered: boolean
}) => {
    return {
        type: IS_REGISTERED,
        ...data
    }
};




type AllTransaction =
    | typeof setIsRegistered

export type AllOutput = ReturnType<AllTransaction>;

export type Output<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never