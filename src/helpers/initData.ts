import { WriteStatus } from '~/types/fleetInfo';

const initWrite: WriteStatus = {
  write: {
    send_mission: [],
    check_mission: [],
    start_mission: false,
    cancel_mission: false,
    pause: false,
    canTakeGoods: false,
    canDropGoods: false,
    heartbeat: 0,
    charge_mission: false,
  },
  region: {
    regionType: '',
    max_height: 0,
    min_height: 0,
    max_speed: 0,
  },
  action: {
    operation: {
      type: '',
      control: [],
      wait: 0,
      is_define_id: '',
      id: 0,
      is_define_yaw: false,
      yaw: 0,
      tolerance: 0,
      lookahead: 0,
      roughly_pass: false,
      from: 0,
      to: 0,
      hasCargoToProcess: false,
      max_forward: 0,
      min_forward: 0,
      max_backward: 0,
      min_backward: 0,
    },
    io: {
      fork: {
        is_define_height: '',
        height: 0,
        move: 0,
        shift: 0,
        tilt: 0,
      },
      camera: {
        config: 0,
        modify_dis: 0,
      },
    },
    cargo_limit: {
      load: 0,
      offload: 0,
    },
    mission_status: {
      feedback_id: '',
      name: [],
      start: '',
      end: '',
    },
  },
};

export default initWrite;
