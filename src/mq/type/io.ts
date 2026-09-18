import { CMD_ID } from "./cmdId";


interface Base<A> {
    id: string;
    sender: string;
    serialNum: string;
    session: string;
    timeStamp: string;
    flag: "REQ";
    amrId?: string;
    payload: A
}


export type EmergencyStop = {
    cmd_id: CMD_ID.EMERGENCY_STOP,
    id: string,
    amrId: string,
    payload: string
}
export type EMERGENCY_STOP = Base<EmergencyStop>;


export type HasCargo = {
    cmd_id: CMD_ID.HAS_CARGO,
    amrId: string,
    id: string,
    hasCargo: string
}
export type HAS_CARGO = Base<HasCargo>;


export type AllIO = EMERGENCY_STOP | HAS_CARGO