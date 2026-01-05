import { Subject } from "rxjs";
import { TCLoggerNormal } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { CMD_ID } from "~/mq/type/cmdId";
import * as ROS from "../ros";
import { RES_EX } from "~/mq/type/type";
import config from "../configs";
import { sendBaseResponse } from "~/mq/transactionsWrapper";
import { ReturnCode } from "~/mq/type/returnCode";
import { AllControl } from "~/mq/type/control";
import { AllRes } from "~/mq/type/res";
import { TRANSACTION_INFO } from "~/types/status";

class MoveControl {
  private registering = false;


  private isAllowSub$: Subject<{ locationId: string, isAllow: boolean }> = new Subject();


  constructor(
    private rb: RBClient,
    private info: TRANSACTION_INFO,
  ) {
    this.rb.onControlTransaction((action) => {
      this.controlProcess(action);
    });

    this.rb.onResTransaction((action) => {
      this.resProcess(action);
    });




    this.mock();
  }

  private controlProcess(action: AllControl) {
    try {
      const { payload } = action;
      const { id, cmd_id, amrId } = payload;
      switch (cmd_id) {
        case CMD_ID.SHORTEST_PATH:
          const { shortestPath, init, rotateFlag } = payload;
          TCLoggerNormal.info("send shortest path", {
            group: "tc",
            type: "shortest path [req]",
            status: { shortestPath, rotateFlag, init }
          });

          ROS.sendShortestPath(this.rb, {
            shortestPath,
            id,
            amrId
          });

          break;
        case CMD_ID.ALLOW_PATH:
          const { isAllow, locationId } = payload;
          if (this.registering) {
            this.isAllowSub$.next({ locationId, isAllow })
            this.rb.resPublish(
              RES_EX,
              `qams.${config.MAC}.res.isAllow`,
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
      default:
        break;
    }
  }



  private mock() {
    // interval(4000).subscribe(() => {
    //   this.emitArriveLoc({ locationId: "123", isArrive: true})
    // })
  }
}

export default MoveControl;