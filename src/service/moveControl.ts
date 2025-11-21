import { filter, fromEventPattern, interval, Subject, switchMap, take, takeUntil, tap, throttleTime } from "rxjs";
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

class MoveControl {
  private amrId: string = "";
  private lastCurrentId = ""
  private isWorking: boolean = false;
  private permitted: string[] = [];
  private occupy: string[] = [];

  private targetLoc: string = ""

  private registerSub$: Subject<boolean> = new Subject();
  private cancelMission$: Subject<boolean> = new Subject();
  private registering: boolean = false;

  private isAllowSub$: Subject<{ locationId: string, isAllow: boolean }> = new Subject();
  constructor(
    private rb: RBClient,
    private map: MapType
  ) {
    this.rb.onControlTransaction((action) => {
      try {
        const { payload } = action;
        const { id, cmd_id, amrId } = payload;
        switch (cmd_id) {
          case CMD_ID.REGISTER:
            this.rb.resPublish(
              RES_EX,
              `amr.res.${config.MAC}.volatile`,
              sendBaseResponse({ amrId, return_code: ReturnCode.success, cmd_id: CMD_ID.REGISTER, id }), { expiration: "3000" }
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
              rb.resPublish(
                RES_EX,
                `amr.res.${config.MAC}.volatile`,
                sendBaseResponse({
                  amrId, return_code: ReturnCode.success,
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
    });

    this.rb.onResTransaction((action) => {
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
        return ROS.getArriveTarget$.pipe(take(1), takeUntil(this.cancelMission$));
      })
    ).subscribe((isArriveRes) => {
      const resData = (isArriveRes as { data: string }).data;

      const parseData = JSON.parse(resData) as { isArrive: boolean, locationId: string };

      const nowPermittedLoc = this.permitted[0];
      const { locationId: receiveLoc } = parseData;

      if (receiveLoc !== nowPermittedLoc) {
        this.abnormalProcess(receiveLoc, nowPermittedLoc);
        this.emitReachGoal(nowPermittedLoc);
        this.registering = false;
        TCLoggerNormal.info(
          `register success: Arrive location ${nowPermittedLoc}`,
          {
            group: "traffic",
            type: "register",
          }
        );
        return;
      }

      this.occupy.push(nowPermittedLoc);
      this.permitted.pop();

      this.emitArriveLoc(parseData);
      this.emitReachGoal(parseData.locationId);
      TCLoggerNormal.info(
        `register success: Arrive location ${isArriveRes.data}`,
        {
          group: "traffic",
          type: "register",
        }
      );
      this.registering = false;
    });


    this.isAllowSub$.pipe(
      filter(({ isAllow }) => { return isAllow }),
      switchMap(() => {
        return ROS.getArriveTarget$.pipe(take(1), takeUntil(this.cancelMission$))
      })
    ).subscribe((arrive) => {
      const jData = JSON.parse((arrive as { data: string }).data);
      TCLoggerNormal.info(`receive arrive location ${jData.locationId}`, {
        group: "traffic",
        type: "isArrive",
      });

      const nowPermittedLoc = this.permitted[0];
      const { locationId: receiveLoc } = jData;

      if (receiveLoc !== nowPermittedLoc) {
        this.abnormalProcess(receiveLoc, nowPermittedLoc)
        if (nowPermittedLoc == this.targetLoc) {
          this.emitReachGoal(this.targetLoc);
        }
        return;
      }
      this.occupy.push(nowPermittedLoc);
      this.permitted.pop();

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
        return ROS.getLeaveLocation$.pipe(take(1), takeUntil(this.cancelMission$));
      })
    ).subscribe((leave) => {
      const jData = JSON.parse(leave.data) as { locationId: string };
      const { locationId: receiveLoc } = jData;
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
          return;
        }
      };
      for (let i = this.occupy.length - 1; i >= 0; i--) {
        if (this.occupy[i] === nowOccupiedLoc) {
          this.occupy.splice(i, 1);
        }
      };
      this.emitLeaveLoc(nowOccupiedLoc);

    });

    this.cancelMission$.subscribe(() => {
      while (this.permitted.length) this.permitted.pop();
      while (this.occupy.length) this.occupy.pop();
      this.occupy.push(this.lastCurrentId);
    })


    this.mock();
  }

  public setAmrId(amrId: string) {
    this.amrId = amrId;
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

    if (ComparLocs.length < 2) throw Error("can't found loc");

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
    this.cancelMission$.next(true);
    this.stopWorking();
  }

  private abnormalProcess(receiveLoc, nowPermittedLoc) {
    if (!this.inTolerance(nowPermittedLoc, receiveLoc)) {
      TCLoggerNormalError.error(`receive location: ${receiveLoc} is greater than tolerance with ${nowPermittedLoc}`, {
        group: "traffic",
        type: "isArrive",
        status: { permitted: this.permitted, occupy: this.occupy }
      })
      return;
    } else {
      this.occupy.push(nowPermittedLoc);
      this.permitted.pop();
      this.emitArriveLoc({ isArrive: true, locationId: nowPermittedLoc });
    };
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