export type AMR_STATUS =
    { amrHasMission: boolean, poseAccurate: boolean, currentId: string }

export type MISSION_STATUS =
    {
        missionType: string,
        lastSendGoalId: string,
        targetLoc: string,
        lastTransactionId: string
    }

export type CONNECT_STATUS =
    { qams_isConnect: boolean, amr_service_isConnect: boolean, rabbitMQ_isConnect: boolean, rosbridge_isConnect: boolean }

export type TRANSACTION_INFO = { amrId: string, qamsSerialNum: string; session: string, return_code: string, approveNotSameSession: boolean } 