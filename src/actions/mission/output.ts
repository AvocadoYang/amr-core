const PREFIX = "MISSION_MANAGER";


export const MISSION_INFO = `${PREFIX}/MISSION_INFO` as const;
export const setMissionInfo = (data: {
    missionType: string;
    lastSendGoalId: string;
    lastTransactionId: string
}) => {
    return {
        type: MISSION_INFO,
        ...data
    }
};

export const CANCEL_MISSION = `${PREFIX}/CANCEL_MISSION` as const;
export const sendCancelMission = (data: {
    missionId: string;
}) => {
    return {
        type: CANCEL_MISSION,
        ...data
    }
}

export const AMR_HAS_MISSION = `${PREFIX}/AMR_HAS_MISSION` as const;
export const sendAmrHasMission = (data: {
    hasMission: boolean
}) => {
    return {
        type: AMR_HAS_MISSION,
        ...data
    }
}

export const START_MISSION = `${PREFIX}/START_MISSION` as const;
export const sendStartMission = () => {
    return {
        type: START_MISSION
    }
}
export const END_MISSION = `${PREFIX}/END_MISSION` as const;
export const sendEndMission = () => {
    return {
        type: END_MISSION
    }
}

export const TARGET_LOC = `${PREFIX}/REACH_GOAL` as const;
export const sendTargetLoc = (data: {
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
    | typeof sendCancelMission
    | typeof sendStartMission
    | typeof sendEndMission
    | typeof sendAmrHasMission

export type AllOutput = ReturnType<AllTransaction>;

export type Output<T extends AllOutput['type'] | AllTransaction = AllOutput['type'], A extends AllOutput = AllOutput> = A extends { type: T }
    ? A
    : A extends { type: ReturnType<T extends AllTransaction ? T : never>['type'] }
    ? A
    : never