import { interval, Subject } from "rxjs";
import * as ROS from '../ros'
import config from "../configs";
import { Output, sendCancelMission, sendStartMission, sendTargetLoc, setMissionInfo } from "~/actions/mission/output";
import { TCLoggerNormal, TCLoggerNormalError, TCLoggerNormalWarning } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { CMD_ID, fakeFeedBack } from "~/mq/type/cmdId";
import { sendBaseResponse, sendFeedBack, sendReadStatus } from "~/mq/transactionsWrapper";
import { group } from "console";
import { ReturnCode } from "~/mq/type/returnCode";
import { IO_EX, RES_EX } from "~/mq/type/type";

export default class Mission {
  private output$: Subject<Output>
  private executing: boolean = false;
  private missionType: string = "";
  private lastSendGoalId: string = "";
  private targetLoc: string = "";
  private lastTransactionId: string = "";
  private amrId: string = ""
  constructor(
    private rb: RBClient
  ) {
    this.output$ = new Subject();

    this.rb.onReqTransaction((action) => {
      const { payload } = action;
      const { id, cmd_id, amrId } = payload;
      switch (payload.cmd_id) {
        case CMD_ID.WRITE_STATUS:
          const { status } = payload;
          const { operation } = status.Body;
          const misType = operation.type;
          TCLoggerNormal.info(`receive mission (${misType})`, {
            group: "mission",
            type: "new mission",
            status:
              misType === "move"
                ? { mid: status.Id, dest: operation.locationId.toString() }
                : { mid: status.Id },
          });

          if (misType === "move") {
            this.output$.next(sendTargetLoc({ targetLoc: this.targetLoc }));
            this.output$.next(sendStartMission());
          };

          this.updateStatue({
            missionType: misType,
            lastSendGoadId: status.Id,
            targetLoc: misType === "move" ? operation.locationId.toString() : "",
            lastTransactionId: id
          })

          ROS.writeStatus(status);

          this.rb.resPublish(
            RES_EX,
            `amr.res.${config.MAC}.promise.writeStatus`,
            sendBaseResponse({ cmd_id, return_code: ReturnCode.success, amrId, id })
          );
          break;
        case CMD_ID.WRITE_CANCEL:
          this.output$.next(sendCancelMission({ missionId: payload.feedback_id }));

          this.updateStatue({ lastSendGoadId: "", missionType: "", targetLoc: "", lastTransactionId: "" });

          ROS.cancelCarStatusAnyway(payload.feedback_id);
          this.rb.resPublish(
            RES_EX,
            `amr.res.${config.MAC}.promise.writeCancel`,
            sendBaseResponse({ cmd_id, return_code: ReturnCode.success, amrId, id })
          );

          break;
        default:
          break;
      }
    });


    /** 任務中回傳值 Action Feedback
     * Feedback Content:
         Message {
            header: {
            seq: 3,
            stamp: { secs: 1708049462, nsecs: 974755287 },
            frame_id: ''
            },
            status: { goal_id: { stamp: [Object], id: '12345' }, status: 1, text: '' },
            feedback: {
            feedback_json: '{"task_process": 0, "warning": 0, "warning_id": 23, "warning_msg": "\\u6b63\\u5e38", "is_running": null, "cancel_task": false, "task_status": true}'
            }
            }
    */
    ROS.getFeedbackFromMoveAction$.subscribe((Feedback) => {
      const { status, feedback } = Feedback;
      const actionId = status.goal_id.id;

      if (this.lastSendGoalId !== actionId) {
        TCLoggerNormalError.error(
          `execute action ID: ${this.lastSendGoalId} not equal to feedback action ID: ${actionId}`,
          {
            group: "mission",
            type: "ros handshake",
          }
        );
        this.missionType = "";
        this.lastSendGoalId = "";
        this.targetLoc = "";
        this.executing = false;
        return;
      };

      this.executing = true;

      this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.feedback`, sendFeedBack(feedback.feedback_json), { expiration: "3000" })
    });

    ROS.getReadStatus$.subscribe((readStatus) => {
      if (!this.executing) {
        TCLoggerNormalWarning.warn(`No mission is currently in progress.`, {
          group: "mission",
          type: "abnormal read status",
          status: readStatus
        })
      }

      const newState = {
        read: {
          feedback_id: readStatus.status.goal_id.id, // 我們的uid
          action_status: readStatus.status.status,
          result_status: readStatus.result.result_status,
          result_message: readStatus.result.result_message,
        },
      };
      const copyMsg = {
        ...newState.read,
        result_message: JSON.parse(newState.read.result_message),
      };

      TCLoggerNormal.info(`mission [${this.missionType}] complete`, {
        group: "mission",
        type: "mission complete",
        status:
          this.missionType === "move"
            ? { mid: this.lastSendGoalId, dest: this.targetLoc, mission: copyMsg }
            : { mid: this.lastSendGoalId, mission: copyMsg },
      });

      if (this.missionType == "move") {
        //sendTargetLoc
      };

      this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.handshake.readStatus`, sendReadStatus(newState), {
        persistent: true
      });

      this.missionType = "";
      this.targetLoc = "";
      this.executing = false;
    });

  }

  private mock() {

    // interval(200).subscribe(() => {
    //     this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.feedback`, sendFeedBack(JSON.stringify(fakeFeedBack)), { expiration: "2000"})
    // })


    // setInterval(() => {
    //     const fake = {
    //         read: {
    //             feedback_id: "test", // 我們的uid
    //             action_status: 123,
    //             result_status: 123,
    //             result_message: "test", 
    //         }
    //     }
    //     this.rb.reqPublish(IO_EX,`amr.io.${config.MAC}.handshake.readStatus` ,sendReadStatus(fake), {
    //         persistent: true
    //     });
    // }, 10000)

  }

  private updateStatue(data: { missionType: string, lastSendGoadId: string, targetLoc: string, lastTransactionId: string }) {

    this.missionType = data.missionType;
    this.lastSendGoalId = data.lastSendGoadId;
    this.targetLoc = data.targetLoc;
    this.lastTransactionId = data.lastTransactionId;

    this.output$.next(setMissionInfo({
      missionType: this.missionType,
      lastSendGoalId: this.lastSendGoalId,
      lastTransactionId: this.lastTransactionId
    }));
  }

  public subscribe(cb: (action: Output) => void) {
    return this.output$.subscribe(cb);
  }

  public setAmrId(amrId: string) {
    this.amrId = amrId;
  }

}