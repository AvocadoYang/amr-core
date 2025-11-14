import { RBClient } from '~/mq';
import * as ROS from '../ros'
import config from "../configs";
import { sendErrorInfo } from '~/mq/transactionsWrapper';
import { CMD_ID } from '~/mq/type/cmdId';
import { interval } from 'rxjs';

class Status {
    constructor(
         private rb: RBClient
    ){
        ROS.getAmrError$.subscribe((msg: { data: string}) => {
            const jMsg = JSON.parse(msg.data) as {
                warning_msg: string[];
                warning_id: string[];
              };
            this.rb.sendToReqQueue(`errorInfo/${config.MAC}/REQ`,sendErrorInfo(jMsg), CMD_ID.ERROR_INFO);
        });

        interval(4000).subscribe(() => {
            const jMsg = {
                warning_msg: ["1", "2"],
                warning_id: ["3", "4"]
            }
            this.rb.sendToReqQueue(`errorInfo/${config.MAC}/REQ`,sendErrorInfo(jMsg), CMD_ID.ERROR_INFO);
        })
    }

    
}


export default Status;