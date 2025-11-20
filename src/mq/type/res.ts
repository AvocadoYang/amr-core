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

export type Arrive_Loc = {
    return_code: ReturnCode;
    id: string;
    cmd_id: CMD_ID.ARRIVE_LOC
}
export type ARRIVE_LOC = Base<Arrive_Loc>

export type Leave_Loc = {
    return_code: ReturnCode;
    id: string;
    cmd_id: CMD_ID.LEAVE_LOC
};
export type LEAVE_LOC = Base<Leave_Loc>;

export type Reach_Goal = {
    return_code: ReturnCode;
    id: string;
    cmd_id: CMD_ID.REACH_GOAL
}
export type REACH_GOAL = Base<Reach_Goal>


export type AllRes = READ_STATUS | CARGO_VERITY | ARRIVE_LOC | LEAVE_LOC | REACH_GOAL;