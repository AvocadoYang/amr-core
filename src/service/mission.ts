import { interval, Subject } from "rxjs";
import * as ROS from '../ros'
import config from "../configs";
import { Output, sendAmrHasMission, sendCancelMission, sendStartMission, sendTargetLoc, setMissionInfo } from "~/actions/mission/output";
import { TCLoggerNormal, TCLoggerNormalError, TCLoggerNormalWarning } from "~/logger/trafficCenterLogger";
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
        TCLoggerNormalError.error(
          `execute action ID: ${this.missionStatus.lastSendGoalId} not equal to feedback action ID: ${actionId}`,
          {
            group: "ms",
            type: "ros handshake",
          }
        );
        ROS.cancelCarStatusAnyway(actionId)
        return;
      };

      this.rb.reqPublish(IO_EX, `amr.io.${config.MAC}.feedback`, sendFeedBack(feedback.feedback_json), { expiration: "3000" })
    });

    ROS.getReadStatus$.subscribe((readStatus) => {
      if (!this.missionStatus.lastSendGoalId) {
        TCLoggerNormalWarning.warn(`No mission is currently in progress.`, {
          group: "ms",
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

      TCLoggerNormal.info(`mission [${this.missionStatus.missionType}] complete`, {
        group: "ms",
        type: "mission complete",
        status:
          this.missionStatus.missionType === "move"
            ? { mid: this.missionStatus.lastSendGoalId, dest: this.missionStatus.targetLoc, mission: copyMsg }
            : { mid: this.missionStatus.lastSendGoalId, mission: copyMsg },
      });
      this.resetMissionStatus();


      this.rb.reqPublish(CONTROL_EX, `qams.${config.MAC}.handshake.readStatus`, sendReadStatus(newState));


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
        TCLoggerNormal.info(`receive mission (${misType})`, {
          group: "ms",
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
          `qams.${config.MAC}.res.writeStatus`,
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
        ROS.cancelCarStatusAnyway(payload.feedback_id);
        TCLoggerNormal.info(`receive cancel mission`, {
          group: "ms",
          type: "cancel mission",
          status: { cancel_id: payload.feedback_id, executing_id: this.missionStatus.lastTransactionId }
        });
        this.rb.resPublish(
          RES_EX,
          `qams.${config.MAC}.res.writeCancel`,
          sendBaseResponse({
            cmd_id,
            return_code: ReturnCode.SUCCESS,
            amrId,
            id
          })
        );
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

    TCLoggerNormal.info(`mission status`, {
      type: "mission status",
      status: this.missionStatus
    })
  };

  public resetMissionStatus() {
    this.missionStatus.missionType = "";
    this.missionStatus.lastSendGoalId = "";
    this.missionStatus.targetLoc = "";
    this.missionStatus.lastTransactionId = "";
    TCLoggerNormal.info(`mission status`, {
      type: "mission status",
      status: this.missionStatus
    })
  }


  public subscribe(cb: (action: Output) => void) {
    return this.output$.subscribe(cb);
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

}