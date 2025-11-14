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

export const REACH_GOAL = `${PREFIX}/REACH_GOAL` as const;
export const sendReachGoal = (data:{
    targetLoc: string
}) => {
    return {
        type: REACH_GOAL,
        ...data,
    }
} 


type AllTransaction = 
    | typeof setMissionInfo
    | typeof sendReachGoal

export type AllOutput = ReturnType<AllTransaction>;

export type Output<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never