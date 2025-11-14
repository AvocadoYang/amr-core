import { Mission_Payload } from "~/types/fleetInfo";
import { CMD_ID } from "./cmdId";

interface Base<A> {
    cmd_id: A;
    id: string;
    flag: "REQ";
}

interface WriteStatus extends Base<CMD_ID.WRITE_STATUS> {
    amrId: string,
    status: Mission_Payload,
    actionType: string, 
    locationId: number
}

interface WriteCancel extends Base<CMD_ID.WRITE_CANCEL> {
    feedback_id: string,
    amrId: string
}


export type AllReq = WriteStatus | WriteCancel