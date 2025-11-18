import { CMD_ID } from "./cmdId";

interface Base<A> {
    cmd_id: A;
    id: string;
}

export interface Control extends Base<CMD_ID.REGISTER> {
    timestamp: string;
    flag: "RES";
    return_code: string;
}



export type AllControl = Control

