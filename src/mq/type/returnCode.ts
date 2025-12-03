export enum ReturnCode {
    SUCCESS = "0000",
    UNDELIVERABLE = "1111",

    NORMAL_REGISTER = "3000",
    REGISTER_FORMAT_ERROR = "3333",
    REGISTER_ERROR_NOT_IN_SYSTEM = "3334",
    REGISTER_ERROR_AMR_NOT_REGISTER = "3332",
    REGISTER_ERROR_MISSION_NOT_EQUAL = "3335",

    shortestPathServiceFailed = "0001",
    isAllowServiceFailed = "0002",
    IS_ARRIVE_ERROR = "0003",
    IS_AWAY_ERROR = "0005",
}


export const registerReturnCode = [
    ReturnCode.SUCCESS,
    ReturnCode.NORMAL_REGISTER,
    ReturnCode.REGISTER_FORMAT_ERROR,
    ReturnCode.REGISTER_ERROR_NOT_IN_SYSTEM,
    ReturnCode.REGISTER_ERROR_AMR_NOT_REGISTER,
    ReturnCode.REGISTER_ERROR_MISSION_NOT_EQUAL
]

