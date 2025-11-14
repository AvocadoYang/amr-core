import { CMD_ID } from "./cmdId";


interface Base<A> {
    cmd_id: A;
    id: string;
    return_code: string;
    flag: "RES";
};

interface Heartbeat extends Base<CMD_ID.HEARTBEAT>{
    heartbeat: number;
}

interface Feedback extends Base<CMD_ID.FEEDBACK>{}

interface ReadStatus extends Base<CMD_ID.READ_STATUS>{}





export type AllRes = Heartbeat | Feedback | ReadStatus;