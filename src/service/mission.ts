import { interval, Subject } from "rxjs";
import * as ROS from '../ros'
import config from "../configs";
import { Output, sendReachGoal, setMissionInfo } from "~/actions/mission/output";
import { TCLoggerNormal, TCLoggerNormalError, TCLoggerNormalWarning } from "~/logger/trafficCenterLogger";
import { RBClient } from "~/mq";
import { CMD_ID } from "~/mq/type/cmdId";
import { sendFeedBack, sendReadStatus } from "~/mq/transactionsWrapper";
import { group } from "console";

export default class Mission {
    private output$: Subject<Output>
    private executing: boolean = false;
    private missionType: string = "";
    private lastSendGoalId: string = "";
    private targetLoc: string = ""
    constructor(
        private rb: RBClient
    ){
        this.output$ = new Subject();
        this.rb.onTransaction((action) => {
            const { id, cmd_id} = action;
            switch(action.cmd_id){
                case CMD_ID.WRITE_STATUS:

                    const { status } = action;
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

                    ROS.writeStatus(status);

                    this.missionType = misType;
                    this.lastSendGoalId = status.Id;
                    this.targetLoc = misType === "move" ? operation.locationId.toString(): "";
                    this.rb.sendToResQueue(`writeStatus/${config.MAC}/RES`, JSON.stringify({
                        return_code: "0000",
                        id,
                        cmd_id
                    }), CMD_ID.WRITE_CANCEL)
                    break;
                case CMD_ID.FEEDBACK:
                    console.log(action, '@@@@@@@@')
                    break;
                case CMD_ID.READ_STATUS:
                    console.log(action, '@@@@@@@@@')
                    break;
                case CMD_ID.WRITE_CANCEL:
                    ROS.cancelCarStatusAnyway(this.lastSendGoalId)
                    this.missionType = "";
                    this.targetLoc = "";
                    this.lastSendGoalId = "";
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
            const { status, feedback} = Feedback;
            const actionId = status.goal_id.id;

            if(this.lastSendGoalId !== actionId){
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
            }
            
            this.output$.next(setMissionInfo({
                missionType: this.missionType,
                lastSendGoalId: this.lastSendGoalId,
                targetLoc: this.targetLoc
            }));

            this.executing = true;
            
            this.rb.sendToReqQueue(`missionFeedback/${config.MAC}/REQ`, sendFeedBack(feedback.feedback_json), CMD_ID.FEEDBACK);
        });


        ROS.getReadStatus$.subscribe((readStatus) => {
            if(!this.executing){
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

            if(this.missionType == "move"){
                this.output$.next(sendReachGoal({ targetLoc: this.targetLoc}));
            };

            this.rb.sendToReqQueue(`readStatus/${config.MAC}/REQ`, JSON.stringify(newState), CMD_ID.READ_STATUS);

            this.missionType = "";
            this.targetLoc = "";
            this.executing = false;
        });
    }

    public subscribe(cb: (action: Output) => void){
          return this.output$.subscribe(cb);
      }
}