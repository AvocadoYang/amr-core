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
        awaitingReconcile: boolean,
        // a mission result ROS reported that QAMS has not acknowledged yet (READ_STATUS still
        // unacked). Reported in every CONNECTION_HEALTH so QAMS can settle a mission that
        // finished during a disconnect instead of seeing a goal id with no mission behind it.
        pendingReadStatus: PENDING_READ_STATUS | null
    }

export type READ_RESULT = {
    feedback_id: string,
    action_status: number,
    result_status: number,
    result_message: string,
}

// id is the READ_STATUS transaction id, so QAMS can dedup against the copy in the queue
export type PENDING_READ_STATUS = { id: string, read: READ_RESULT }

export type CONNECT_STATUS =
    { qams_isConnect: boolean, amr_service_isConnect: boolean, rabbitMQ_isConnect: boolean, rosbridge_isConnect: boolean }

export type TRANSACTION_INFO = { amrId?: string, qamsSerialNum?: string; session?: string, return_code?: string, approveNotSameSession?: boolean } 