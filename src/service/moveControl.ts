import { concatMap, filter, fromEventPattern, interval, merge, Subject, switchMap, take, takeUntil, tap, throttleTime } from "rxjs";
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
  private initShortestPath: string[] = [];

  private isAllowSub$: Subject<{ locationId: string, isAllow: boolean }> = new Subject();
  private closeArriveLoc$: Subject<string> = new Subject();

  private closeAwayLoc$: Subject<string> = new Subject();
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
          group: "tc",
          type: "register",
        });
        this.registering = true
        this.initShortestPath = [];
        this.permitted.length = 0;
      }),
      switchMap(() => {
        return this.isAllowSub$.pipe(
          filter(({ locationId, isAllow }) => {
            if (!this.initShortestPath.length || !isAllow || locationId !== this.initShortestPath[0]) return false;
            return true
          }),
          tap(() => {
            this.permitted.push(this.initShortestPath[0]);
            setTimeout(() => {
              ROS.sendShortestPath(this.rb, { shortestPath: this.initShortestPath, id: "#", amrId: this.info.amrId })
            }, 1000);
          }),
          switchMap(({ locationId }) => {
            return this.ws.isArriveObs.pipe(
              takeUntil(
                merge(
                  this.cancelMission$,
                  this.closeArriveLoc$.pipe(filter((arriveLoc) => arriveLoc == locationId), tap(() => { console.log("complete arrive") }))
                )))
          })
        )
      })
    ).subscribe(({ locationId: receiveLoc, ack }) => {
      const nowPermittedLoc = this.permitted[0];

      if (receiveLoc !== nowPermittedLoc && !this.abnormalProcess({ receiveLoc, nowPermittedLoc, type: "is_arrive" })) {
        ack({ return_code: ReturnCode.IS_ARRIVE_ERROR, expect: nowPermittedLoc, receive: receiveLoc });
        this.permitted.pop();
        this.closeArriveLoc$.next(nowPermittedLoc);
        return;
      }

      this.occupy.push(nowPermittedLoc);
      this.permitted.pop();
      ack({ return_code: ReturnCode.SUCCESS, expect: nowPermittedLoc, receive: receiveLoc });

      this.emitArriveLoc({ isArrive: true, locationId: nowPermittedLoc });
      this.emitReachGoal(nowPermittedLoc);
      TCLoggerNormal.info(
        `register success: receive arrive location: ${nowPermittedLoc}`,
        {
          group: "tc",
          type: "register",
          status: { occupy: this.occupy, permitted: this.permitted }
        }
      );
      this.closeArriveLoc$.next(nowPermittedLoc);
      this.registering = false;
      this.initShortestPath = [];
    })



    this.isAllowSub$.pipe(
      filter(({ isAllow }) => { return isAllow && !this.registering }),
      switchMap(() => {
        return this.ws.isArriveObs.pipe(takeUntil(merge(this.cancelMission$, this.closeArriveLoc$)))
      })
    ).subscribe(({ locationId: receiveLoc, ack }) => {
      const nowPermittedLoc = this.permitted[0];
      if (receiveLoc !== nowPermittedLoc && !this.abnormalProcess({ receiveLoc, nowPermittedLoc, type: "is_arrive" })) {
        ack({ return_code: ReturnCode.IS_AWAY_ERROR, expect: nowPermittedLoc, receive: receiveLoc });
        return;
      }

      this.emitArriveLoc({ isArrive: true, locationId: nowPermittedLoc });
      if (nowPermittedLoc == this.targetLoc) this.emitReachGoal(this.targetLoc);
      this.occupy.push(this.permitted.shift());

      ack({ return_code: ReturnCode.SUCCESS, expect: nowPermittedLoc, receive: receiveLoc });

      TCLoggerNormal.info(`receive arrive location ${receiveLoc}`, {
        group: "tc",
        type: "is_arrive",
        status: { occupy: this.occupy, permitted: this.permitted }
      });

      this.closeArriveLoc$.next(nowPermittedLoc);
    });

    this.isAllowSub$.pipe(
      filter(({ isAllow, locationId }) => { return isAllow && locationId !== this.targetLoc && !this.registering }),
      concatMap(({ locationId }) => {
        TCLoggerNormal.info("create leave location obs", {
          group: "tc",
          type: "create leave obs",
          status: { waitLeave: locationId },
        });
        return this.ws.isAwayObs
          .pipe(
            filter(({ locationId: awayPoint }) => awayPoint == locationId),
            takeUntil(
              merge(this.cancelMission$, this.closeAwayLoc$.pipe(filter((loc) => loc == locationId)))
            )
          )
      })
    ).subscribe(({ locationId: receiveLoc, ack }) => {

      if (!this.occupy.length) {
        TCLoggerNormalWarning.warn(`receive leave location, but occupied array is empty`, {
          group: "tc",
          type: "is_away ",
          status: { occupy: this.occupy, permitted: this.permitted }
        });
        ack({ return_code: ReturnCode.IS_AWAY_ERROR, expect: "#", receive: receiveLoc });
        return;
      }
      const nowOccupiedLoc = this.occupy[0];
      if (receiveLoc !== nowOccupiedLoc && !this.abnormalProcess({ receiveLoc, nowPermittedLoc: nowOccupiedLoc, type: "is_away" })) {
        return ack({ return_code: ReturnCode.IS_AWAY_ERROR, expect: nowOccupiedLoc, receive: receiveLoc });;
      };

      for (let i = this.occupy.length - 1; i >= 0; i--) {
        if (this.occupy[i] === nowOccupiedLoc) {
          this.occupy.splice(i, 1);
        }
      };
      TCLoggerNormal.info(
        `receive leave location ${receiveLoc}`,
        {
          group: "tc",
          type: "is_away",
          status: { occupy: this.occupy, permitted: this.permitted }
        }
      );
      ack({ return_code: ReturnCode.SUCCESS, expect: nowOccupiedLoc, receive: receiveLoc })
      this.emitLeaveLoc(nowOccupiedLoc);
      this.closeAwayLoc$.next(nowOccupiedLoc)
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
          const { shortestPath, init, rotateFlag } = payload;
          TCLoggerNormal.info("send shortest path", {
            group: "tc",
            type: "shortest path [req]",
            status: { shortestPath, rotateFlag, init }
          });

          if (init) {
            this.initShortestPath = shortestPath;
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
          } else {
            this.permitted.push(locationId)
            ROS.sendIsAllowTarget(this.rb, { locationId, isAllow, amrId, id });
          };
          TCLoggerNormal.info("receive allow location message", {
            group: "tc",
            type: "is_allow",
            status: { isAllow, locationId, occupy: this.occupy, permitted: this.permitted, registering: this.registering }
          });
          this.isAllowSub$.next({ isAllow, locationId });
          break;
        case CMD_ID.REROUTE_PATH:
          TCLoggerNormal.info("send reroute path", {
            group: "tc",
            type: "shortest path [req]",
            status: { reroutePath: payload.reroutePath, rotateFlag: payload.rotateFlag }
          });
          ROS.sendReroutePath(this.rb, { reroutePath: payload.reroutePath, id, amrId });
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
        // console.log(action, '@@@@')
        break;
      case CMD_ID.LEAVE_LOC:
        // console.log(action, '@@@@')
        break;
      case CMD_ID.REACH_GOAL:
        // console.log(action, '@@@@')
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

    if (ComparLocs.length < 2) return { canPass: false, dist: -1 };

    const [locA, locB] = ComparLocs;
    const { x: x1, y: y1 } = locA;
    const { x: x2, y: y2 } = locB;

    const dx = x1 - x2;
    const dy = y1 - y2;

    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= 1.5) return { canPass: true, dist: distance }

    return { canPass: false, dist: distance };

  }

  public cancelMissionSignal() {
    if (this.isWorking) {
      this.cancelMission$.next(true);
      this.stopWorking();
    }
  }

  private abnormalProcess(data: { receiveLoc: string, nowPermittedLoc: string, type: string }) {
    const { receiveLoc, nowPermittedLoc, type } = data;
    const { canPass, dist } = this.inTolerance(nowPermittedLoc, receiveLoc);
    if (!canPass) {
      TCLoggerNormalError.error(`receive location: ${receiveLoc} is greater than tolerance with ${nowPermittedLoc} by ${dist}m`, {
        group: "tc",
        type,
        status: { permitted: this.permitted, occupy: this.occupy }
      })
      return false;
    }
    return true
  }

  public resetStatus(trafficStatus: { occupied: string[], permitted: string[] }) {
    const { occupied: tc_occupied, permitted: tc_permitted } = trafficStatus;
    TCLoggerNormal.info(`reset operator status`, {
      type: "operator",
      group: "mc",
      status: { tc_op: { occupy: tc_occupied, permitted: tc_permitted }, amr_op: { occupy: this.occupy, permitted: this.permitted } }
    })
    this.occupy.length = 0;
    this.permitted.length = 0;
    tc_occupied.forEach((loc) => this.occupy.push(loc));
    tc_permitted.forEach((loc) => this.permitted.push(loc));
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