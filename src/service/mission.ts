import { interval, Subject } from "rxjs";
import * as ROS from '../ros'
import { MAC } from "../configs";
import { Output, sendAmrHasMission, sendCancelMission, sendStartMission, sendTargetLoc, setMissionInfo } from "~/actions/mission/output";
import { infoLogger, warnLogger, errorLogger } from "~/logger/logger";
import { RBClient } from "~/mq";
import { CMD_ID } from "~/mq/type/cmdId";
import { sendBaseResponse, sendFeedBack, sendReadStatus, sendWriteStatusResponse } from "~/mq/transactionsWrapper";
import { ReturnCode } from "~/mq/type/returnCode";
import { CONTROL_EX, IO_EX, RES_EX } from "~/mq/type/type";
import { AllControl } from "~/mq/type/control";
import { AMR_STATUS, CONNECT_STATUS, MISSION_STATUS, TRANSACTION_INFO } from "~/types/status";

export default class Mission {
  private output$: Subject<Output>

  constructor(
    private rb: RBClient,
    private missionStatus: MISSION_STATUS
  ) {
    this.output$ = new Subject();

    this.rb.onControlTransaction((action) => {
      this.reqProcess(action);
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

      if (this.missionStatus.lastSendGoalId !== actionId) {
        errorLogger.error(
          `execute action ID: ${this.missionStatus.lastSendGoalId} not equal to feedback action ID: ${actionId}`,
          {
            title: "mission",
            type: "ros handshake",
          }
        );
        ROS.cancelCarStatusAnyway(actionId)
        return;
      };

      this.rb.reqPublish(IO_EX, `amr.io.${MAC}.feedback`, sendFeedBack(feedback.feedback_json), { expiration: "3000" })
    });

    ROS.getReadStatus$.subscribe((readStatus) => {
      if (!this.missionStatus.lastSendGoalId) {
        warnLogger.warn(`No mission is currently in progress.`, {
          title: "mission",
          type: "abnormal read status",
          status: readStatus
        });
        return;
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

      infoLogger.info(`mission [${this.missionStatus.missionType}] complete`, {
        title: "mission",
        type: "mission complete",
        status:
          this.missionStatus.missionType === "move"
            ? { mid: this.missionStatus.lastSendGoalId, dest: this.missionStatus.targetLoc, mission: copyMsg }
            : { mid: this.missionStatus.lastSendGoalId, mission: copyMsg },
      });
      this.resetMissionStatus();


      this.rb.reqPublish(CONTROL_EX, `qams.${MAC}.handshake.readStatus`, sendReadStatus(newState));


      this.output$.next(sendAmrHasMission({ hasMission: false }))

    });

  }

  private reqProcess(action: AllControl) {
    const { payload } = action;
    const { id, cmd_id, amrId } = payload;
    switch (payload.cmd_id) {
      case CMD_ID.WRITE_STATUS:
        const { status } = payload;
        const { operation } = status.Body;
        const misType = operation.type;
        infoLogger.info(`receive mission (${misType})`, {
          title: "mission",
          type: "new mission",
          status:
            misType === "move"
              ? { mid: status.Id, dest: operation.locationId.toString() }
              : { mid: status.Id },
        });

        if (misType === "move") {
          this.missionStatus.targetLoc = operation.locationId.toString();
        };

        this.updateStatue({
          missionType: misType,
          lastSendGoalId: status.Id,
          targetLoc: misType === "move" ? operation.locationId.toString() : "",
          lastTransactionId: id
        })


        this.rb.resPublish(
          RES_EX,
          `qams.${MAC}.res.writeStatus`,
          sendWriteStatusResponse({
            return_code: ReturnCode.SUCCESS,
            amrId,
            id,
            lastSendGoalId: status.Id,
            missionType: misType
          })
        );

        ROS.writeStatus(status);
        break;
      case CMD_ID.WRITE_CANCEL:
        this.rb.resPublish(
          RES_EX,
          `qams.${MAC}.res.writeCancel`,
          sendBaseResponse({
            cmd_id,
            return_code: ReturnCode.SUCCESS,
            amrId,
            id
          })
        );
        this.resetMissionStatus();
        ROS.cancelCarStatusAnyway(payload.feedback_id);
        break;
      default:
        break;
    }
  }

  public updateStatue(data: { missionType?: string, lastSendGoalId?: string, targetLoc?: string, lastTransactionId?: string }) {
    this.missionStatus.missionType = data.missionType ?? this.missionStatus.missionType;
    this.missionStatus.lastSendGoalId = data.lastSendGoalId ?? this.missionStatus.lastSendGoalId;
    this.missionStatus.targetLoc = data.targetLoc ?? this.missionStatus.targetLoc;
    this.missionStatus.lastTransactionId = data.lastTransactionId ?? this.missionStatus.lastTransactionId;

    infoLogger.info(`mission status update`, {
      title: "mission",
      type: "mission status",
      status: this.missionStatus
    })
  };

  public resetMissionStatus() {
    this.missionStatus.missionType = "";
    this.missionStatus.lastSendGoalId = "";
    this.missionStatus.targetLoc = "";
    this.missionStatus.lastTransactionId = "";
    warnLogger.warn(`reset mission status`, {
      title: "mission",
      type: "mission status",
      status: this.missionStatus
    })
  }


  public subscribe(cb: (action: Output) => void) {
    return this.output$.subscribe(cb);
  }



  private mock() {

    // interval(200).subscribe(() => {
    //     this.rb.reqPublish(IO_EX, `amr.io.${MAC}.feedback`, sendFeedBack(JSON.stringify(fakeFeedBack)), { expiration: "2000"})
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
    //     this.rb.reqPublish(IO_EX,`amr.io.${MAC}.handshake.readStatus` ,sendReadStatus(fake), {
    //         persistent: true
    //     });
    // }, 10000)

  }

}