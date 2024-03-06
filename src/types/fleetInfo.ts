// 寫入插車
export type WriteStatus = {
  write: {
    send_mission: Array<number>;
    check_mission: Array<number>;
    start_mission: boolean;
    cancel_mission: boolean;
    pause: boolean;
    canTakeGoods: boolean;
    canDropGoods: boolean;
    heartbeat: number;
    charge_mission: boolean;
  };

  region: {
    regionType: string;
    max_height: number;
    min_height: number;
    max_speed: number;
  };
  action: {
    operation: {
      type: string;
      control: Array<string>;
      wait: number;
      is_define_id: string;
      id: number;
      is_define_yaw: boolean;
      yaw: number;
      tolerance: number;
      lookahead: number;
      roughly_pass: boolean;
      from: number;
      to: number;
      hasCargoToProcess: boolean;
      max_forward: number;
      min_forward: number;
      max_backward: number;
      min_backward: number;
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
    };
  };
};

export type ConvertedWriteStatus = {
  operation: {
    type: string;
    action_id: string;
    new_task: boolean;
  };
  move: {
    control: string[];
    goal_id: number;
    wait: number;
    is_define_yaw: boolean;
    yaw: number;
    tolerance: number;
    lookahead: number;
    from: number;
    to: number;
    hasCargoToProcess: boolean;
    max_forward: number;
    min_forward: number;
    max_backward: number;
    min_backward: number;
    traffic_light_status: boolean;
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
  };
};

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
