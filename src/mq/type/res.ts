import { CMD_ID } from "./cmdId";
import { ReturnCode } from "./returnCode";


interface Base<A> {
    id: string;
    sender: string;
    serialNum: string;
    flag: "RES";
    amrId?: string;
    payload: A
};



export type ReadStatus = {
    return_code: ReturnCode;
    id: string;
    cmd_id: CMD_ID.READ_STATUS
}
export type READ_STATUS = Base<ReadStatus>

export type CargoVerity = {
    return_code: ReturnCode;
    id: string;
    cmd_id: CMD_ID.CARGO_VERITY
}
export type CARGO_VERITY = Base<CargoVerity>;




export type AllRes = READ_STATUS | CARGO_VERITY;