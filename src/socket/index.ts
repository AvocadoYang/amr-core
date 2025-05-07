import chalk from 'chalk';
import { fromEventPattern, map, share, tap } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import config from '~/config';
// import { SimplePose, formatPose, sanitizeDegree } from '~/helpers';
import logger from '~/logger';
import { Mission_Payload } from '~/types/fleetInfo';

let socket: Socket;

export function init(serialNumber: string) {
  const url = `wss://${config.MISSION_CONTROL_HOST}:${config.MISSION_CONTROL_PORT}/amr`;
  socket = io(url, { query: { serialNumber }, secure: true,
    rejectUnauthorized: false, });
}

export function responseShortestPath() {
  socket.emit('res-shortestPath', { test: 'test' });
}

export const connect$ = fromEventPattern<never>((next) =>
  socket.on('connect', next),
).pipe(share());

export const disconnect$ = fromEventPattern<never>((next) =>
  socket.on('disconnect', next),
).pipe(share());

export const connectionError$ = fromEventPattern<Error>((next) =>
  socket.on('connect_error', next),
).pipe(share());

export const writeStatus$ = fromEventPattern<{
  status: Mission_Payload,
  actionType: string,
  locationId: number
}>((next) => {
  socket.on('write-status', next);
}).pipe(share());

export const writeCancel$ = fromEventPattern<{
  id: string;
}>((next) => {
  socket.on('write-cancel', next);
}).pipe(share());

export const pause$ = fromEventPattern<{
  payload: string;
}>((next) => {
  socket.on('pause', next);
}).pipe(share());

export const moveToPoint$ = fromEventPattern<{
  tolerance: number;
  locationId?: string;
}>((next) => socket.on('move-to-point', next)).pipe(
  tap((target) => {
    // console.log(chalk.bgYellow('move to poient'));
    // console.log(target);
  }),
  map((target) => ({
    ...target,
    tolerance: 0.1,
  })),
  share(),
);

export const moveToPointPrecisely$ = fromEventPattern<{
  tolerance: number;
  locationId?: string;
}>((next) => socket.on('move-to-point-precisely', next)).pipe(
  tap((pose) => {
    // console.log(chalk.bgMagentaBright('move to precise'));
    // console.log(pose);
  }),
  map((target) => ({
    ...target,
    tolerance: 0.1,
  })),
  share(),
);

// ======= communication with Jack =======


export const startOneTermAllowPath$ = fromEventPattern<{ amrId: string, start:boolean}>(
  (next) => socket.on('start-initial', next),
).pipe(share());

export const shortestPath$ = fromEventPattern<{ shortestPath: string[] }>(
  (next) => socket.on('shortest-path', next),
).pipe(share());

export const reroutePath$ = fromEventPattern<{ reroutePath: string[]}>(
  (next) => socket.on('reroute-path', next),
).pipe(share());

export const allowPath$ = fromEventPattern<{
  locationId: string;
  isAllow: boolean;
}>((next) => socket.on('allow-path', next)).pipe(share());

export function sendIsArriveLocation(arriveMsg: {
  locationId: string;
  isArrive: boolean;
}) {
  console.log(`🚩 location ${arriveMsg.locationId} is arriving `)
  socket.emit('arrive-loc', arriveMsg);
}

export function sendIsLeaveLocation(isAwayMsg: {locationId: string}){
  socket.emit('leave-location', isAwayMsg)
}


export const yellowImgLog$ = fromEventPattern<{ imgPath: string }>(
  (next) => socket.on('yellow-img-log-path', next),
).pipe(share());

export function sendServiceYellowResult(image_data: string,result: boolean,result_msg:string) {
  socket.volatile.emit('send-yellow-img-log', {image_data,result,result_msg});
}


export function sendShortestIsReceived(result) {
  socket.volatile.emit('receive-shortestPath', { result });
}

export function sendReroutePathInProcess(response){
  socket.volatile.emit('reroute-response', response);
}

export function sendWriteStateFeedback(feedback: string) {
  socket.volatile.emit('writeStatus-feedback', { feedback });
}


export function sendCarErrorInfo(errorInfo: { warning_msg: string[]; warning_id: string[];}){
  socket.volatile.emit('car-error-info', errorInfo);
}

// ======= communication with Jack =======

export function sendReadStatus(msg: string) {
  console.log('it has send read Statue')
  socket.volatile.emit('read-status', { msg });
}

export function sendIOInfo(msg: string) {
  socket.volatile.emit('io-info', { msg });
}

export function sendError(error: string) {
  // logger.http(`emit socket 'error' { rosError: ${error}}`);
  socket.volatile.emit('ros-error', { rosError: error });
}

export function sendStatus(status: string) {
  // logger.http(`emit socket 'status' { rosStatus: ${status}}`);
  socket.volatile.emit('ros-status', { rosStatus: status });
}

// 回傳座標到fleet
export function sendPose(x: number, y: number, yaw: number) {
  socket.volatile.emit('pose', { x, y, yaw });
}

// 回傳已到座標到fleeet
export function sendReachGoal(locationId: string) {
  logger.http(`emit socket 'reach-goal' ${locationId}`);
  socket.emit('reach-goal', { locationId });
}


export const updatePosition$ = fromEventPattern<{ isUpdate: boolean }>(
  (next) => socket.on('write-new-position', next),
).pipe(share());

export function sendGas(msg: string) {
  socket.volatile.emit('yellow-car-gas', msg );
}

export function sendThermal(msg: string) {
  socket.volatile.emit('yellow-car-thermal', msg );
}

export function sendRealTimeReadStatus(msg: string) {
  socket.volatile.emit('real-time-read-status', { msg });
}

export function sendAmrDisconnect(MacAddress: string) {
  socket.volatile.emit('disconnect', {MacAddress});
}
export function sendRosBridgeConnection(online: boolean) {
  socket.volatile.emit('rosbridge-connection', { online });
}


export function sendRetryConnect(retryCount: number) {
  socket.volatile.emit('trying-reconnection',  retryCount );
}


export function topicTask(msg: string) {
  socket.volatile.emit('topic-task',  msg );
}


// 回傳已到座標到fleeet
export function sendCurrentId(currentId: string) {

  socket.emit('currentId', currentId);
}
