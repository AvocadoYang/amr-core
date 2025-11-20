import { CMD_ID } from "./cmdId";

interface Base<A> {
    id: string;
    sender: string;
    serialNum: string;
    flag: "REQ";
    amrId?: string;
    payload: A
}

export type Register = {
    cmd_id: CMD_ID.REGISTER,
    amrId: string,
    id: string,
    heartbeat: number,
    timestamp: number
}
export type REGISTER = Base<Register>;

export type ShortestPath = {
    cmd_id: CMD_ID.SHORTEST_PATH,
    amrId: string,
    id: string,
    shortestPath: string[],
    init: boolean
};
export type SHORTEST_PATH = Base<ShortestPath>;

export type IsAllowPath = {
    cmd_id: CMD_ID.ALLOW_PATH,
    amrId: string,
    id: string,
    isAllow: boolean,
    locationId: string
}
export type IS_ALLOW_PATH = Base<IsAllowPath>


export type AllControl =
 REGISTER |
 SHORTEST_PATH |
 IS_ALLOW_PATH

