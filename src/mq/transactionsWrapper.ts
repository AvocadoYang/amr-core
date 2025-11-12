import * as faker from 'faker';
import { CMD_ID } from './type/cmdId';

export const sendHeartbeat = (heartbeat: number) =>{
    return JSON.stringify({
        cmd_id: CMD_ID.HEARTBEAT,
        id: faker.datatype.uuid(),
        heartbeat
    })
}

export const sendPose = (pose: { x: number, y: number, yaw: number}) => {
    return JSON.stringify({
        cmd_id: CMD_ID.POSE,
        id: faker.datatype.uuid(),
        ...pose
    })
}