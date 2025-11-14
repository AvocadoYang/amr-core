import * as faker from 'faker';
import { CMD_ID } from './type/cmdId';
import { error } from 'console';

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

export const sendFeedBack = (feedback: string) => {
    return JSON.stringify({
        cmd_id: CMD_ID.FEEDBACK,
        id: faker.datatype.uuid(),
        feedback
    })
}

export const sendReadStatus = (read: string) => {
    return JSON.stringify({
        cmd_id: CMD_ID.READ_STATUS,
        id: faker.datatype.uuid(),
        msg: read
    })
}

export const sendErrorInfo = (errorInfo: {
    warning_msg: string[];
    warning_id: string[];
}) => {
    return JSON.stringify({
        cmd_id: CMD_ID.ERROR_INFO,
        id: faker.datatype.uuid(),
        ...errorInfo
    })
}