import { concatMap, filter, timer, fromEventPattern, interval, merge, Subject, switchMap, take, takeUntil, tap, throttleTime } from "rxjs";
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

  private targetLoc: string = ""
  private registering = false;

  private registerSub$: Subject<boolean> = new Subject();
  private cancelMission$: Subject<boolean> = new Subject();
  private initShortestPath: string[] = [];

  private isAllowSub$: Subject<{ locationId: string, isAllow: boolean }> = new Subject();


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

    this.ws.isArriveObs.subscribe(({ locationId, ack }) => {
      ack({ return_code: ReturnCode.SUCCESS, expect: locationId, receive: locationId });
    })

    this.ws.isAwayObs.subscribe(({ locationId, ack }) => {
      ack({ return_code: ReturnCode.SUCCESS, expect: locationId, receive: locationId });
    })

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
      }),
      switchMap(() => {
        return this.isAllowSub$.pipe(
          filter(({ locationId, isAllow }) => {
            if (!this.initShortestPath.length || !isAllow || locationId !== this.initShortestPath[0]) return false;
            return true
          }),
          tap(() => {
            setTimeout(() => {
              ROS.sendShortestPath(this.rb, { shortestPath: this.initShortestPath, id: "#", amrId: this.info.amrId })
            }, 1000);
          })
        )
      })
    ).subscribe(() => {
      this.registering = false;
      this.initShortestPath = [];
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
            ROS.sendIsAllowTarget(this.rb, { locationId, isAllow, amrId, id });
          };
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
      case CMD_ID.READ_STATUS:
        // console.log(action, '@@@@')
        break;
      case CMD_ID.CARGO_VERITY:
        // console.log(action, '@@@@')
        break;
        break;
      default:
        break;
    }
  }


  public setTargetLoc(locationId: string) {
    this.targetLoc = locationId;
  }



  public cancelMissionSignal() {
    if (this.isWorking) {
      this.cancelMission$.next(true);
      this.stopWorking();
    }
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