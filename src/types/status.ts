export type AMR_STATUS =
    { amrHasMission: boolean, poseAccurate: boolean, currentId: string }

export type MISSION_STATUS =
    {
        missionType: string,
        lastSendGoalId: string,
        targetLoc: string,
        lastTransactionId: string,
        // true from process boot until the first register response is handled - marks
        // local mission state as not-yet-trustworthy so a restart mid-mission doesn't
        // self-cancel the AMR's real in-progress goal before QAMS has had a say
        awaitingReconcile: boolean
    }

export type CONNECT_STATUS =
    { qams_isConnect: boolean, amr_service_isConnect: boolean, rabbitMQ_isConnect: boolean, rosbridge_isConnect: boolean }

export type TRANSACTION_INFO = { amrId: string, qamsSerialNum: string; session: string, return_code: string, approveNotSameSession: boolean } 