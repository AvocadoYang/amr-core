import { Mission_Payload } from "~/types/fleetInfo";
import { CMD_ID } from "./cmdId";

interface Base<A> {
    id: string;
    sender: string;
    serialNum: string;
    session: string;
    flag: "REQ";
    amrId?: string;
    payload: A
}


export type ShortestPath = {
    cmd_id: CMD_ID.SHORTEST_PATH,
    amrId: string,
    id: string,
    shortestPath: string[],
    rotateFlag: number[],
    init: boolean
};
export type SHORTEST_PATH = Base<ShortestPath>;

export type ReroutePath = {
    cmd_id: CMD_ID.REROUTE_PATH,
    amrId: string,
    id: string,
    reroutePath: string[],
    rotateFlag: number[],
}
export type REROUTE_PATH = Base<ReroutePath>;

export type IsAllowPath = {
    cmd_id: CMD_ID.ALLOW_PATH,
    amrId: string,
    id: string,
    isAllow: boolean,
    locationId: string
}
export type IS_ALLOW_PATH = Base<IsAllowPath>


export type Heartbeat = {
    cmd_id: CMD_ID.HEARTBEAT,
    amrId: string,
    id: string,
    heartbeat: number,
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

export type HasCargo = {
    cmd_id: CMD_ID.HAS_CARGO,
    amrId: string,
    id: string,
    hasCargo: boolean
}
export type HAS_CARGO = Base<HasCargo>;




export type AllControl =
    SHORTEST_PATH |
    IS_ALLOW_PATH |
    REROUTE_PATH |
    WRITE_CANCEL |
    WRITE_STATUS |
    UPDATE_POSE |
    EMERGENCY_STOP |
    FORCE_RESET |
    HAS_CARGO;

