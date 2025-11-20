const PREFIX = "MISSION_MANAGER";


export const MISSION_INFO = `${PREFIX}/MISSION_INFO` as const;
export const setMissionInfo = (data: {
    missionType: string;
    lastSendGoalId: string;
    targetLoc:string;
}) => {
    return {
        type: MISSION_INFO,
        ...data
    }
};

export const TARGET_LOC = `${PREFIX}/REACH_GOAL` as const;
export const sendTargetLoc = (data:{
    targetLoc: string
}) => {
    return {
        type: TARGET_LOC,
        ...data,
    }
}


type AllTransaction = 
    | typeof setMissionInfo
    | typeof sendTargetLoc

export type AllOutput = ReturnType<AllTransaction>;

export type Output<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never