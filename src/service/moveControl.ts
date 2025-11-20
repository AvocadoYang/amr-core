import { filter, fromEventPattern, interval, Subject, switchMap, take, tap } from "rxjs";
import { TCLoggerNormal } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { CMD_ID } from "~/mq/type/cmdId";
import * as ROS from "../ros";
import { MapType } from "~/types/map";
import { IO_EX, RES_EX } from "~/mq/type/type";
import config from "../configs";
import { sendBaseResponse, sendIsArrive, sendLeaveLoc, sendReachGoal } from "~/mq/transactionsWrapper";
import { ReturnCode } from "~/mq/type/returnCode";

class MoveControl {
    private amrId: string = "";
    private frontier: string[] = [];
    private permitted: string[] = [];
    private occupy: string[] = [];

    private targetLoc: string = ""

    private registerSub$: Subject<boolean> = new Subject();
    private isAllowSub$: Subject<{ locationId: string, isAllow:boolean}> = new Subject();
    constructor(
        private rb: RBClient,
        private map: MapType 
    ){
      this.rb.onControlTransaction((action) => {
        try{
          const { payload } = action;
          const { id, cmd_id, amrId } = payload;
          switch(cmd_id){
              case CMD_ID.REGISTER:
                  this.rb.resPublish(
                    RES_EX,
                    `amr.res.${config.MAC}.promise`,
                    sendBaseResponse({ amrId, return_code: ReturnCode.success, cmd_id: CMD_ID.REGISTER, id })
                  );
                  this.registerSub$.next(true);
                  break;
              case CMD_ID.SHORTEST_PATH:
                  const { shortestPath, init } = payload;
                  if(init){
                    this.frontier.push(shortestPath[0]);
                    this.permitted.push(shortestPath[0]);
                  }
                  ROS.sendShortestPath(this.rb, {
                    shortestPath,
                    id,
                    amrId
                  });
                  break;
                case CMD_ID.ALLOW_PATH:
                  const { isAllow, locationId } = payload;
                  TCLoggerNormal.info("receive isAllow message", {
                    group: "traffic",
                    type: "isAllow",
                    status: { isAllow, locationId}
                  });
                  
                  this.isAllowSub$.next({ isAllow, locationId});
                  ROS.sendIsAllowTarget(this.rb, { locationId, isAllow, amrId, id});
                  break;
              default:
                  break;
          };
        } catch(err){

        }
      });

      this.rb.onResTransaction((action) => {
        const { payload } = action;
        switch(payload.cmd_id){
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
      })
      
      this.registerSub$.pipe(
          tap(() => {
              TCLoggerNormal.info("start register", {
                group: "traffic",
                type: "register",
              });
            }),
          switchMap(() => {
              return ROS.getArriveTarget$.pipe(take(1));
          })
          ).subscribe((isArriveRes) => {
              TCLoggerNormal.info(
                  `register success: Arrive location ${isArriveRes.data}`,
                  {
                    group: "traffic",
                    type: "register",
                  }
                );
              const resData = (isArriveRes as { data: string }).data;
        
              const parseData = JSON.parse(resData) as { isArrive: boolean, locationId: string};
              this.emitArriveLoc(parseData);
              this.emitReachGoal(parseData.locationId);
          });

        this.isAllowSub$.pipe(
          filter(({ isAllow }) => { return isAllow}),
          switchMap(() => {
            return ROS.getArriveTarget$.pipe(take(1))
          })
        ).subscribe((isArriveRes) => {
             TCLoggerNormal.info(`receive arrive location ${isArriveRes.data}`, {
              group: "traffic",
              type: "isArrive",
            });
            const resData = (isArriveRes as { data: string }).data;
            const parseData = JSON.parse(resData);
            // if (targetLoc === allowTarget.locationId) {
            //   SOCKET.sendReachGoal(parseData.locationId);
            // }
        });

        this.isAllowSub$.pipe(
          filter(( { isAllow, locationId }) => { return isAllow && locationId == this.targetLoc}),
          switchMap(() => {
            return ROS.getLeaveLocation$.pipe(take(1));
          })
        ).subscribe()

        
      this.mock();
    }

    public setAmrId(amrId: string){
      this.amrId = amrId;
  }
  
  public setTargetLoc(locationId: string){
    this.targetLoc = locationId;
  }

  private emitReachGoal(locationId: string){
    this.rb.reqPublish(
      IO_EX, 
      `amr.io.${config.MAC}.handshake.reachGoal}`,
      sendReachGoal(locationId)
    )
  }

  private emitArriveLoc(data: { locationId: string, isArrive: boolean}){
    const { locationId, isArrive } = data;
    this.rb.reqPublish(
      IO_EX,
      `amr.io.${config.MAC}.handshake.isArrive`,
      sendIsArrive(isArrive, locationId)
    )
  }

  private emitLeaveLoc(locationId: string){
    this.rb.reqPublish(
      IO_EX,
      `amr.io.${config.MAC}.handshake.leaveLoc`,
      sendLeaveLoc(locationId)
    )
  }


  private mock(){
    // interval(4000).subscribe(() => {
    //   this.emitArriveLoc({ locationId: "123", isArrive: true})
    // })
  }
}

export default MoveControl;