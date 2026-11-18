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


/** QAMS 叫車端上 / 解充電鎖 (見 service/chargeLock.ts) */
export type ChargeLockReq = {
    cmd_id: CMD_ID.CHARGE_LOCK,
    id: string,
    amrId: string,
    requestId: string,
    lock: boolean,
    reason: string,
    /** 哪一座充電站 (點位 ID); 舊版 QAMS 不帶 */
    dockLocationId?: string
}
export type CHARGE_LOCK = Base<ChargeLockReq>;


export type AllIO = EMERGENCY_STOP | HAS_CARGO | CHARGE_LOCK