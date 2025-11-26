import { filter, fromEventPattern, interval, merge, Subject, switchMap, take, takeUntil, tap, throttleTime } from "rxjs";
import { TCLoggerNormal, TCLoggerNormalError, TCLoggerNormalWarning } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { CMD_ID } from "~/mq/type/cmdId";
import * as ROS from "../ros";
import { MapType } from "~/types/map";
import { IO_EX, RES_EX } from "~/mq/type/type";
import config from "../configs";
import { sendBaseResponse, sendIsArrive, sendLeaveLoc, sendReachGoal } from "~/mq/transactionsWrapper";
import { ReturnCode } from "~/mq/type/returnCode";
import { group } from "console";
import { AllControl } from "~/mq/type/control";
import { AllRes } from "~/mq/type/res";
import WsServer from "./ws";

class MoveControl {
  private lastCurrentId = ""
  private isWorking: boolean = false;
  private permitted: string[] = [];
  private occupy: string[] = [];

  private targetLoc: string = ""

  private registerSub$: Subject<boolean> = new Subject();
  private cancelMission$: Subject<boolean> = new Subject();
  private registering: boolean = false;

  private isAllowSub$: Subject<{ locationId: string, isAllow: boolean }> = new Subject();
  private closeArriveLoc$: Subject<boolean> = new Subject();

  private closeAwayLoc$: Subject<boolean> = new Subject();
  constructor(
    private rb: RBClient,
    private ws: WsServer,
    private info: { amrId: string, isConnect: boolean },
    private map: MapType
  ) {
    this.rb.onControlTransaction((action) => {
      this.controlProcess(action);
    });

    this.rb.onResTransaction((action) => {
      this.resProcess(action);
    });

    ROS.currentId$.pipe(throttleTime(2000)).subscribe((currentId) => {
      this.lastCurrentId = currentId;
    });

    this.registerSub$.pipe(
      tap(() => {
        TCLoggerNormal.info("start register", {
          group: "traffic",
          type: "register",
        });
      }),
      switchMap(() => {
        return this.ws.isArriveObs.pipe(takeUntil(merge(this.cancelMission$, this.closeArriveLoc$)))
      })
    ).subscribe(({ locationId: receiveLoc, ack }) => {

      const nowPermittedLoc = this.permitted[0];

      if (receiveLoc !== nowPermittedLoc) {
        const isSuccess = this.abnormalProcess(receiveLoc, nowPermittedLoc);
        if (!isSuccess) {
          ack({ return_code: ReturnCode.IS_ARRIVE_ERROR, locationId: nowPermittedLoc });
          this.permitted.pop()
          return;
        }
        this.emitReachGoal(nowPermittedLoc);
        this.registering = false;
        ack({ return_code: ReturnCode.SUCCESS })
        TCLoggerNormal.info(
          `register success: Arrive location ${nowPermittedLoc}`,
          {
            group: "traffic",
            type: "register",
          }
        );
        this.closeArriveLoc$.next(true);
      }

      this.occupy.push(nowPermittedLoc);
      this.permitted.pop();

      this.emitArriveLoc({ isArrive: true, locationId: nowPermittedLoc });
      this.emitReachGoal(nowPermittedLoc);
      TCLoggerNormal.info(
        `register success: Arrive location: ${nowPermittedLoc}`,
        {
          group: "traffic",
          type: "register",
        }
      );
      this.registering = false;
    })



    this.isAllowSub$.pipe(
      filter(({ isAllow }) => { return isAllow }),
      switchMap(() => {
        return this.ws.isArriveObs.pipe(takeUntil(merge(this.cancelMission$, this.closeArriveLoc$)))
      })
    ).subscribe(({ locationId: receiveLoc, ack }) => {
      TCLoggerNormal.info(`receive arrive location ${receiveLoc}`, {
        group: "traffic",
        type: "isArrive",
      });
      const nowPermittedLoc = this.permitted[0];
      if (receiveLoc !== nowPermittedLoc) {
        const isSuccess = this.abnormalProcess(receiveLoc, nowPermittedLoc)
        if (!isSuccess) {
          ack({ return_code: ReturnCode.IS_AWAY_ERROR, locationId: nowPermittedLoc });
          return;
        }
        if (nowPermittedLoc == this.targetLoc) {
          this.emitReachGoal(this.targetLoc);
        }
      } else {
        this.emitArriveLoc({ isArrive: true, locationId: nowPermittedLoc });
        if (nowPermittedLoc == this.targetLoc) {
          this.emitReachGoal(this.targetLoc);
        }
        this.occupy.push(nowPermittedLoc);
        this.permitted.pop();
      }
      ack({ return_code: ReturnCode.SUCCESS, locationId: nowPermittedLoc });
      this.closeArriveLoc$.next(true);
    });

    this.isAllowSub$.pipe(
      filter(({ isAllow, locationId }) => { return isAllow && locationId == this.targetLoc }),
      tap(({ locationId }) => {
        TCLoggerNormal.info("create leave location obs", {
          group: "traffic",
          type: "create leave obs",
          status: { waitLeave: locationId },
        });
      }),
      switchMap(() => {
        return this.ws.isAwayObs.pipe(takeUntil(merge(this.cancelMission$, this.closeAwayLoc$)))
      })
    ).subscribe(({ locationId: receiveLoc, ack }) => {
      TCLoggerNormal.info(
        `receive leave location ${receiveLoc}`,
        {
          group: "traffic",
          type: "isAway"
        }
      );

      if (!this.occupy.length) {
        TCLoggerNormalWarning.warn(`occupied array is empty`, {
          group: "traffic",
          type: "isAway",
          status: { occupy: this.occupy, permitted: this.permitted }
        });
        ack({ locationId: "", return_code: ReturnCode.IS_AWAY_ERROR });
        return;
      }
      const nowOccupiedLoc = this.occupy[0];
      if (receiveLoc !== nowOccupiedLoc) {
        if (!this.inTolerance(nowOccupiedLoc, receiveLoc)) {
          TCLoggerNormalError.error(`receive location: ${receiveLoc} is greater than tolerance with ${nowOccupiedLoc}`, {
            group: "traffic",
            type: "isAway",
            status: { permitted: this.permitted, occupy: this.occupy }
          });
          return ack({ locationId: nowOccupiedLoc, return_code: ReturnCode.IS_AWAY_ERROR });;
        }
      };
      for (let i = this.occupy.length - 1; i >= 0; i--) {
        if (this.occupy[i] === nowOccupiedLoc) {
          this.occupy.splice(i, 1);
        }
      };
      ack({ return_code: ReturnCode.SUCCESS, locationId: nowOccupiedLoc })
      this.emitLeaveLoc(nowOccupiedLoc);
      this.closeAwayLoc$.next(true)

    })



    this.cancelMission$.subscribe(() => {
      while (this.permitted.length) this.permitted.pop();
      while (this.occupy.length) this.occupy.pop();
      this.occupy.push(this.lastCurrentId);
    })


    this.mock();
  }

  private controlProcess(action: AllControl) {
    try {
      const { payload } = action;
      const { id, cmd_id, amrId } = payload;
      switch (cmd_id) {
        case CMD_ID.REGISTER:
          this.rb.resPublish(
            RES_EX,
            `amr.res.${config.MAC}.volatile`,
            sendBaseResponse({ amrId, return_code: ReturnCode.SUCCESS, cmd_id: CMD_ID.REGISTER, id }), { expiration: "3000" }
          );
          this.registerSub$.next(true);
          break;
        case CMD_ID.SHORTEST_PATH:
          const { shortestPath, init } = payload;
          if (init) {
            this.registering = true;
            this.permitted.push(shortestPath[0]);
            setTimeout(() => {
              ROS.sendShortestPath(this.rb, { shortestPath, id, amrId })
            }, 1000);
          } else {
            ROS.sendShortestPath(this.rb, {
              shortestPath,
              id,
              amrId
            });
          }
          break;
        case CMD_ID.ALLOW_PATH:
          const { isAllow, locationId } = payload;
          if (this.registering) {
            this.rb.resPublish(
              RES_EX,
              `amr.res.${config.MAC}.volatile`,
              sendBaseResponse({
                amrId, return_code: ReturnCode.SUCCESS,
                cmd_id: CMD_ID.ALLOW_PATH,
                id
              }),
              { expiration: "3000" }
            )
          };

          TCLoggerNormal.info("receive isAllow message", {
            group: "traffic",
            type: "isAllow",
            status: { isAllow, locationId }
          });

          this.isAllowSub$.next({ isAllow, locationId });
          ROS.sendIsAllowTarget(this.rb, { locationId, isAllow, amrId, id });
          break;
        default:
          break;
      };
    } catch (err) {

    }
  }

  private resProcess(action: AllRes) {
    const { payload } = action;
    switch (payload.cmd_id) {
      case CMD_ID.ARRIVE_LOC:
        console.log(action, '@@@@')
        break;
      case CMD_ID.LEAVE_LOC:
        console.log(action, '@@@@')
        break;
      case CMD_ID.REACH_GOAL:
        console.log(action, '@@@@')
        break;
      default:
        break;
    }
  }


  public setTargetLoc(locationId: string) {
    this.targetLoc = locationId;
  }

  private emitReachGoal(locationId: string) {
    this.rb.reqPublish(
      IO_EX,
      `amr.io.${config.MAC}.handshake.reachGoal}`,
      sendReachGoal(locationId)
    )
  }

  private emitArriveLoc(data: { locationId: string, isArrive: boolean }) {
    const { locationId, isArrive } = data;
    this.rb.reqPublish(
      IO_EX,
      `amr.io.${config.MAC}.handshake.isArrive`,
      sendIsArrive(isArrive, locationId)
    )
  }

  private emitLeaveLoc(locationId: string) {
    this.rb.reqPublish(
      IO_EX,
      `amr.io.${config.MAC}.handshake.leaveLoc`,
      sendLeaveLoc(locationId)
    )
  }

  private inTolerance(a: string, b: string) {
    const ComparLocs = this.map.locations.map((loc) => {
      const { locationId, x, y } = loc;
      return {
        locationId,
        x,
        y
      }
    }).filter(({ locationId }) => locationId == a || locationId == b);

    if (ComparLocs.length < 2) return false;

    const [locA, locB] = ComparLocs;
    const { x: x1, y: y1 } = locA;
    const { x: x2, y: y2 } = locB;

    const dx = x1 - x2;
    const dy = y1 - y2;

    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= 1.5) return true

    return false;

  }

  public cancelMissionSignal() {
    if (this.isWorking) {
      this.cancelMission$.next(true);
      this.stopWorking();
    }
  }

  private abnormalProcess(receiveLoc, nowPermittedLoc) {
    if (!this.inTolerance(nowPermittedLoc, receiveLoc)) {
      TCLoggerNormalError.error(`receive location: ${receiveLoc} is greater than tolerance with ${nowPermittedLoc}`, {
        group: "traffic",
        type: "isArrive",
        status: { permitted: this.permitted, occupy: this.occupy }
      })
      return false;
    } else {
      this.occupy.push(nowPermittedLoc);
      this.permitted.pop();
      this.emitArriveLoc({ isArrive: true, locationId: nowPermittedLoc });
    };
    return true
  }

  public resetStatus() {
    this.occupy.length = 0;
    this.permitted.length = 0;
    this.occupy.push(this.lastCurrentId);
  }


  public startWorking() {
    this.isWorking = true;
  }

  public stopWorking() {
    this.isWorking = false;
  }

  private mock() {
    // interval(4000).subscribe(() => {
    //   this.emitArriveLoc({ locationId: "123", isArrive: true})
    // })
  }
}

export default MoveControl;