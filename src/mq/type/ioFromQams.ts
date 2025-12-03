import { CMD_ID } from "./cmdId";

interface Base<A> {
    id: string;
    sender: string;
    serialNum: string;
    flag: "REQ";
    amrId?: string;
    payload: A
}

export type HasCargo = {
    cmd_id: CMD_ID.HAS_CARGO,
    amrId: string,
    id: string,
    hasCargo: boolean
}
export type HAS_CARGO = Base<HasCargo>;


export type AllIO =
    HAS_CARGO