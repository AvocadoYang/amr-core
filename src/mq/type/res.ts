import { CMD_ID } from "./cmdId";
import { ReturnCode } from "./returnCode";


interface Base<A> {
    id: string;
    sender: string;
    serialNum: string;
    session: string;
    timeStamp: string;
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

export type RegisterRes = {
    return_code: ReturnCode;
    id: string;
    cmd_id: CMD_ID.REGISTER;
    applicant: string;
    amrId: string;
    qamsSerialNum: string;
    message: string;
}



export type REGISTER_RES = Base<RegisterRes>;

export type ConnectionHealthRes = {
    cmd_id: CMD_ID.CONNECTION_HEALTH
    return_code: string;
    message: string;
    id: string;
    newSession: string;
    // QAMS has settled this pendingReadStatus (applied it, or it was for a goal QAMS no
    // longer runs) - drop it whatever the return code says about the mission record
    settledReadStatusId?: string;
    // the AMR is running this goal but our record was lost - take it back as our record
    adoptGoalId?: string;
}

export type CONNECTION_HEATH_RES = Base<ConnectionHealthRes>

export type MissionLostRes = {
    return_code: ReturnCode;
    id: string;
    cmd_id: CMD_ID.MISSION_LOST
}
export type MISSION_LOST_RES = Base<MissionLostRes>;


export type AllRes = READ_STATUS | CARGO_VERITY | CONNECTION_HEATH_RES | MISSION_LOST_RES;