import { CMD_ID } from './type/cmdId';
import { ReturnCode } from './type/returnCode';


export const sendHeartbeat = (heartbeat: number) => {
    return {
        cmd_id: CMD_ID.HEARTBEAT,
        heartbeat
    }
}

export const sendPose = (pose: { x: number, y: number, yaw: number }) => {
    return {
        cmd_id: CMD_ID.POSE,
        ...pose,
    }
}

export const sendFeedBack = (feedback: string) => {
    return {
        cmd_id: CMD_ID.FEEDBACK,
        feedback
    }
}

export const sendReadStatus = (data: {
    read: {
        feedback_id: string, // 我們的uid
        action_status: number,
        result_status: number,
        result_message: string,
    }
}) => {
    return {
        cmd_id: CMD_ID.READ_STATUS,
        ...data
    }
}

export const sendErrorInfo = (errorInfo: {
    warning_msg: string[];
    warning_id: string[];
}) => {
    return {
        cmd_id: CMD_ID.ERROR_INFO,
        ...errorInfo
    }
}

export const sendIOInfo = (io: string) => {
    return {
        cmd_id: CMD_ID.IO_INFO,
        io
    }
}

export const sendCurrentId = (currentId: string) => {
    return {
        cmd_id: CMD_ID.CURRENT_ID,
        currentId
    }
}

export const sendPoseAccurate = (isLocalized: boolean) => {
    return {
        cmd_id: CMD_ID.CHECK_POSITION,
        isAccurate: isLocalized
    }
}

export const sendIsRegistered = (isRegistered: boolean) => {
    return {
        cmd_id: CMD_ID.REGISTERED,
        isRegistered
    }
}

export const sendCargoVerity = (msg: string) => {
    return {
        cmd_id: CMD_ID.CARGO_VERITY,
        checkResult: msg
    }
}

export const sendStackInfo = (msg: string) => {
    return {
        cmd_id: CMD_ID.STACK_INFO,
        checkResult: msg
    }
}


export const sendETX = () => {
    return {
        cmd_id: CMD_ID.ETX
    }
}


type AllReqType =
    typeof sendHeartbeat |
    typeof sendReadStatus |
    typeof sendFeedBack |
    typeof sendPose |
    typeof sendErrorInfo |
    typeof sendIOInfo |
    typeof sendCurrentId |
    typeof sendPoseAccurate |
    typeof sendCargoVerity |
    typeof sendIsRegistered |
    typeof sendStackInfo |
    typeof sendETX

export type RequestMsgType = ReturnType<AllReqType>


/** ============================= response below =============================================== */

export const sendBaseResponse = (data: { cmd_id: CMD_ID, return_code: ReturnCode, id: string, amrId: string }) => {
    return data;
}

export const sendHeartBeatResponse = (data: {
    return_code: ReturnCode,
    id: string,
    amrId: string,
    heartbeat: number,
}) => {
    return {
        cmd_id: CMD_ID.HEARTBEAT,
        ...data
    }
}

export const sendWriteStatusResponse = (data: {
    return_code: ReturnCode,
    id: string,
    amrId: string,
    lastSendGoalId: string,
    missionType: string,
}) => {
    return {
        cmd_id: CMD_ID.WRITE_STATUS,
        ...data
    }
}


type AllResType = typeof sendBaseResponse | typeof sendHeartBeatResponse | typeof sendWriteStatusResponse;
export type ResponseMsgType = ReturnType<AllResType>;