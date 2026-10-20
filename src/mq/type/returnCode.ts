export enum ReturnCode {
    SUCCESS = "0000",
    UNDELIVERABLE = "1111",

    MISSION_CONTINUE_LOGIN_SUCCESS = "3000",
    MISSION_NOT_SYNC_LOGIN_SUCCESS = "3001",
    MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_AMR_SERVICE = "3003",
    MISSION_TIMEOUT_LOGIN_SUCCESS = "3002",
    MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_RESET_STATUS_RESEND_MISSION = "3004",
    LOGIN_SUCCESS_UNEXPECTED = "3006",
    // the mission finished while disconnected; QAMS settled it from CH.pendingReadStatus
    MISSION_COMPLETED_DURING_DISCONNECT = "3005",
    // QAMS cannot tell whether the AMR finished the current step (it holds no result and the
    // AMR is idle) and asked a person to check on site - keep the record, touch nothing
    MISSION_RESULT_UNKNOWN = "3007",

    FORMAT_ERROR_LOGIN_ERROR = "3441",
    NOT_IN_SYSTEM_LOGIN_ERROR = "3442",

    shortestPathServiceFailed = "0001",
    isAllowServiceFailed = "0002",
    IS_ARRIVE_ERROR = "0003",
    IS_AWAY_ERROR = "0005",
    reroutePathServiceFailed = "0006"
}


export const registerReturnCode = [
    ReturnCode.SUCCESS,
    ReturnCode.MISSION_CONTINUE_LOGIN_SUCCESS,
    ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS,
    ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_RESET_STATUS_RESEND_MISSION,
    ReturnCode.MISSION_NOT_SYNC_LOGIN_SUCCESS_WITH_AMR_SERVICE,
    ReturnCode.LOGIN_SUCCESS_UNEXPECTED,

    ReturnCode.MISSION_TIMEOUT_LOGIN_SUCCESS,
    ReturnCode.FORMAT_ERROR_LOGIN_ERROR,
    ReturnCode.NOT_IN_SYSTEM_LOGIN_ERROR,
]

