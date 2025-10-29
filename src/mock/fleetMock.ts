import { Server as SocketIOServer } from 'socket.io';
import * as http from 'http';
import { string, boolean, object } from 'yup';
// import { MyRosMessage, WriteStatus } from './types/fleetInfo';
import { Subject, fromEventPattern, share } from 'rxjs';
import chalk from 'chalk';
import config from '~/configs';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const fleetMoveMock = (
  socketClient: any,
  notifyMoveStart$: Subject<boolean>,
) => {
  const httpServer = http.createServer().listen(config.MISSION_CONTROL_PORT);
  const socketIO = new SocketIOServer(httpServer, { cors: { origin: '*' } });

  let currIdx = 0;
  // const shortestPath = ['40401', '40402'];
  // const shortestPath = ['70103', '70104', '70002', '80101'];
  const shortestPath = ['70103', '70105', '70106'];
  const writeStatusMove = {
    write: {
      start_mission: [1, 2, 3, 4],
      cancel_mission: [1, 2, 3, 4],
      pause: false,
      canTakeGoods: false,
      canDropGoods: false,
      heartbeat: 0,
      charge_mission: false,
    },
    region: {
      regionType: 'test',
      max_height: 30,
      min_height: 30,
      max_speed: 10,
    },
    action: {
      operation: {
        type: 'move',
        control: 'F',
        wait: 0,
        is_define_id: true,
        id: 0,
        is_define_yaw: false,
        yaw: 90,
        tolerance: 0,
        lookahead: 0,
        roughly_pass: false,
        from: 0,
        to: 0,
        hasCargoToProcess: false,
        max_forward: 10,
        min_forward: 10,
        max_backward: 10,
        min_backward: 10,
      },
      io: {
        fork: {
          is_define_height: 'auto',
          height: 0,
          move: 0,
          shift: 0,
          tilt: 0,
        },
        camera: {
          config: 10,
          modify_dis: 0,
        },
      },
      cargo_limit: {
        load: 0,
        offload: 0,
      },
      mission_status: {
        feedback_id: '12345',
        name: ['testMission'],
        start: '10',
        end: '20',
      },
    },
  };
  // const writeStatus_others = {
  //   status: {
  //     write: {
  //       start_mission: [1, 2, 3, 4],
  //       cancel_mission: [1, 2, 3, 4],
  //       pause: false,
  //       canTakeGoods: false,
  //       canDropGoods: false,
  //       heartbeat: 0,
  //       charge_mission: false,
  //     },
  //     region: {
  //       regionType: 'test',
  //       max_height: 30,
  //       min_height: 30,
  //       max_speed: 10,
  //     },
  //     action: {
  //       operation: {
  //         type: 'load',
  //         control: ['H'],
  //         wait: 0,
  //         is_define_id: true,
  //         id: 0,
  //         is_define_yaw: false,
  //         yaw: 90,
  //         tolerance: 0,
  //         lookahead: 0,
  //         roughly_pass: false,
  //         from: 0,
  //         to: 0,
  //         hasCargoToProcess: false,
  //         max_forward: 10,
  //         min_forward: 10,
  //         max_backward: 10,
  //         min_backward: 10,
  //       },
  //       io: {
  //         fork: {
  //           is_define_height: 'auto',
  //           height: 0,
  //           move: 0,
  //           shift: 0,
  //           tilt: 0,
  //         },
  //         camera: {
  //           config: 10,
  //           modify_dis: 0,
  //         },
  //       },
  //       cargo_limit: {
  //         load: 0,
  //         offload: 0,
  //       },
  //       mission_status: {
  //         feedback_id: '12345',
  //         name: ['testMission'],
  //         start: '10',
  //         end: '20',
  //       },
  //     },
  //   },
  // };

  socketIO.of('/amr').on('connection', (socket) => {
    const serialNum = socket.handshake.query.serialNumber as string;
    if (!serialNum) return;

    console.log(chalk.red(`Car ${serialNum} mock move is starting`));

    // socket.on('res-shortestPath', (data) => {
    //   console.log(data);
    // });

    socket.emit('write-status', { status: JSON.stringify(writeStatusMove) });
    setTimeout(() => {
      notifyMoveStart$.next(true);
    }, 2000);

    const arriveLocation$ = fromEventPattern<{
      locationId: string;
      isArrive: boolean;
    }>((next) => socket.on('arrive-loc', next)).pipe(share());

    let curr = shortestPath[currIdx];
    const PathLength = shortestPath.length;

    function randomZeroOrOne() {
      return Math.round(Math.random());
    }

    function emitAllowPath(locationId: string) {
      console.log(`✅ location ${locationId} is allowed`);
      socket.emit('allow-path', {
        locationId,
        isAllow: true,
      });
    }

    function emitNotAllowPath(locationId: string) {
      console.log(`❌ location ${locationId} is rejected`);
      socket.emit('allow-path', {
        locationId,
        isAllow: false,
      });
      setTimeout(() => {
        const randomAgain = randomZeroOrOne();
        if (!randomAgain) {
          emitNotAllowPath(locationId);
        } else {
          emitAllowPath(locationId);
        }
      }, 5000);
    }

    setTimeout(() => {
      emitAllowPath(curr);
    }, 4000);

    arriveLocation$.subscribe((arriveMsg) => {
      const schema = object({
        locationId: string().required(),
        isArrive: boolean().required(),
      });
      schema
        .validate(arriveMsg)
        .then(() => {
          if (
            arriveMsg.locationId !== curr ||
            !arriveMsg.isArrive ||
            currIdx >= PathLength - 1
          ) {
            if (currIdx === PathLength - 1) {
              console.log(
                chalk.bgBlue(`🦄 Location ${arriveMsg.locationId} arrive 🦄`),
                '\n',
                '---------------------------------------------',
              );
              if (process.env.MODE === 'debug') {
                console.log('\n', '==========', '\n');
                console.log(`🐝 ${chalk.magenta('moving complete')} 🐝`);
                console.log('\n', '==========');
              }
              return;
            }
            console.log('entry');
            return;
          }
          console.log(
            chalk.bgBlue(`🦄 Location ${arriveMsg.locationId} arrive 🦄`),
            '\n',
            '---------------------------------------------',
          );
          currIdx += 1;
          curr = shortestPath[currIdx];

          const isAllow = randomZeroOrOne();
          if (!isAllow) {
            setTimeout(() => {
              emitNotAllowPath(curr);
            }, 2000);
            return;
          }
          setTimeout(() => {
            emitAllowPath(curr);
          }, 2000);
        })
        .catch(() => {
          console.log('wrong format');
        });
    });
  });
};

export default fleetMoveMock;
