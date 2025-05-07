// 寫入插車

export enum YawGenre {
  CUSTOM,
  SELECT,
  CALCULATE_BY_AGV_AND_SHELF_ANGLE,
}


export type Fork_Action = {
  operation: {
    type: string;
    control: Array<string>;
    wait: number;
    is_define_id: string;
    locationId: number;
    is_define_yaw: YawGenre;
    yaw: number;
    tolerance: number;
    lookahead: number;

    waitOtherAmr: string | null;
    waitGenre: string | null;
    auto_preparatory_point: boolean;
  };
  io: {
    fork: {
      is_define_height: string;
      height: number;
      move: number;
      shift: number;
      tilt: number;
    };
    camera: {
      config: number;
      modify_dis: number;
    };
  };
  cargo_limit: {
    load: number;
    offload: number;
  };
  mission_status: {
    feedback_id: string;
    name: string[];
    start: string;
    end: string;
    bookBlock: string[] | null;
    load_level?: number | null;
    offload_level?: number | null;
  };
};

export type Mission_Payload = {
  Id: string; //傳送此指令的為一值
  Action: "addTaskSlice" //指令類型
  Time: string; //時間戳記
  Device: string; // 傳送對象的 ID
  Body: Fork_Action
}




export type YellowFeedback = {
  is_going_to: number;
  process: string;
  action_process: string;
  traffic_light: string;
};

export interface MyRosMessage {
  header: {
    seq: number;
    stamp: {
      secs: number;
      nsecs: number;
    };
    frame_id: string;
  };
  status: {
    goal_id: {
      stamp: {
        secs: number;
        nsecs: number;
      };
      id: string;
    };
    status: number;
    text: string;
  };
  feedback: {
    feedback_json: string;
  };
  result?: {
    result_status: number;
    result_message: string;
  };
}

export type IsArrive = {
  data: any;
  locationId: string;
  isArrive: boolean;
};

export type isAway = {
  data: any;
  locationId: string;
}

export type FeedbackOfMove = {
  header: {
    seq: number;
    stamp: { secs: number; nsecs: number };
    frame_id: string;
  };
  status: {
    goal_id: {
      stamp: typeof Object;
      id: string;
    };
    status: number;
    text: string;
  };
  feedback: {
    feedback_json: string;
  };
};

export function isLocationIdAndIsAllow(obj: {
  locationId: string;
  isAllow: boolean;
}): obj is { locationId: string; isAllow: boolean } {
  return (
    obj &&
    typeof obj.locationId === 'string' &&
    typeof obj.isAllow === 'boolean'
  );
}