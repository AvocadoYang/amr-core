import { Mission_Payload } from "~/types/fleetInfo";
import { CMD_ID } from "./cmdId";

interface Base<A> {
    id: string;
    sender: string;
    serialNum: string;
    flag: "REQ";
    amrId?: string;
    payload: A
}

export type Heartbeat = {
    cmd_id: CMD_ID.HEARTBEAT,
    amrId: string,
    id: string,
    heartbeat: number,
    timestamp: number
}
export type HEARTBEAT = Base<Heartbeat>;

export type WriteStatus = {
    cmd_id: CMD_ID.WRITE_STATUS
    amrId: string,
    id: string,
    status: Mission_Payload,
    actionType: string, 
    locationId: number
}
export type WRITE_STATUS = Base<WriteStatus>;




export type WriteCancel = {
    cmd_id: CMD_ID.WRITE_CANCEL,
    id: string,
    feedback_id: string,
    amrId: string
}
export type WRITE_CANCEL = Base<WriteCancel>;


export type UpdatePose = {
    cmd_id: CMD_ID.UPDATE_MAP,
    id: string,
    amrId: string,
    isUpdate: boolean
}
export type UPDATE_POSE = Base<UpdatePose>;

export type EmergencyStop = {
    cmd_id: CMD_ID.EMERGENCY_STOP,
    id: string,
    amrId: string,
    payload: string
}
export type EMERGENCY_STOP = Base<EmergencyStop>;

export type ForceReset = {
    cmd_id: CMD_ID.FORCE_RESET,
    id: string,
    amrId: string,
    payload: boolean
}
export type FORCE_RESET = Base<ForceReset> 



export type AllReq =
    HEARTBEAT    |
    WRITE_CANCEL | 
    WRITE_STATUS | 
    UPDATE_POSE | 
    EMERGENCY_STOP | 
    FORCE_RESET;