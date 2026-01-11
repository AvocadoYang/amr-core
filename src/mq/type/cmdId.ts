export enum CMD_ID {
  HEARTBEAT = "HB",
  POSE = "PS",
  WRITE_STATUS = "WS",
  FEEDBACK = "FB",
  READ_STATUS = "RS",
  WRITE_CANCEL = "WC",
  ERROR_INFO = "EI",
  UPDATE_MAP = "UM",
  IO_INFO = "IO",
  CURRENT_ID = "CI",
  EMERGENCY_STOP = "ET",
  FORCE_RESET = "FR",
  CHECK_POSITION = "CP",
  CARGO_VERITY = "CV",
  REGISTER = "RG",
  SHORTEST_PATH = "SP",
  REROUTE_PATH = "RP",
  ALLOW_PATH = "AP",
  REGISTERED = "RD",
  PTVP_SWITCH = "PTVP_SWITCH",

  HAS_CARGO = "HC",

  SYNC_DATA = "SYNC",

  ETX = "ETX"
}

export const blackList = [
  CMD_ID.HEARTBEAT,
  CMD_ID.POSE,
  CMD_ID.FEEDBACK,
  CMD_ID.IO_INFO,
  CMD_ID.CURRENT_ID,
  CMD_ID.ERROR_INFO,
  CMD_ID.REGISTERED,
  CMD_ID.CHECK_POSITION,
  CMD_ID.HAS_CARGO
]

export const fakeFeedBack = {
  task_process: 1,
  navigation_status: true,
  warning: 3,
  warning_id: 1000,
  warning_msg: "test",
  is_running: true,
  cancel_task: true,
  task_status: true
}

export const fakeIoInfo = {
  connect_status: true,
  Query: "GET_STATUS",
  Set: "SET_PARAM",
  MultiSet: "MULTI_SET",
  error_code: "0",
  error_info: null,
  enable_ultrasoumd: true,
  ultrasound: "OK",
  enable_baffle: false,

  baffle_left: null,
  baffle_right: null,
  manual_mode: false,
  enforce_charge: false,
  set_charge: false,

  battery_info: {
    low_battery: false,
    set_charge: 80,
    battery: 92,
    voltage: 54.3,
    current: 3.1,
    charging: true,
    battery_Temp: 32.5,
    battery_flag0: "0x01",
    battery_flag1: "0x00",
    battery_flag2: "0x00",
    write_battery_info_time: 123456789,
    battery_info_error: [],
  },

  fork: {
    set_clamp: 10,
    current_clamp: 8,
    set_height: 120,
    current_height: 118,
    set_move: 0,
    current_move: 0,
    set_tilt: 5,
    current_tilt: 4,
    set_shift: 3,
    current_shift: 2,
  },

  charge_relay_status: true,

  voltage: 53.9,
  current: 3.0,

  front_2d_layer: 1,
  enable_2d_lidar: true,
  obstacle_2d_signal: false,
  obstacle_rear_2d_signal: false,
  obstacle_3d_signal: false,
  enable_recovery: true,
  enable_reboot: false,
  enable_tip: true,
  set_tip: 0,
  tip_left: false,
  tip_right: false,
  set_height: 100,
  current_height: 100,
  set_linear_x: 0.5,
  linear_x: 0.48,
  angular_z: 0,
  odom_x: 12.34,
  odom_y: 56.78,
  odom_w: 1.57,
  emergency_signal: "NONE",
  emergency_stop: false,
  bumper: false,
  recovery: false,
};

