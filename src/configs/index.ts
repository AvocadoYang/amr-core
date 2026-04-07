import { boolean, number, object, string } from "yup";
// eslint-disable-next-line no-restricted-imports
import config from "config";
import chalk from "chalk";
import { format } from "util";

console.log(
  chalk.blue(
    "Load config with following files: ",
    format(config.util.getConfigSources().map((c) => c.name))
  )
);

const schema = object({
  MISSION_CONTROL_HOST: string().required(),
  RABBIT_MQ_HOST: string().required(),
  AMR: string().required(),
  MISSION_CONTROL_PORT: number().integer().min(0).max(65535).required(),
  ROS_BRIDGE_URL: string().required(),
  IFACE_NAME: string().required(),
  DEBUG_LOGGER: boolean().required(),
  HEARTBEAT_LOGGER: boolean().required(),
  MAC: string().required(),

  RABBIT_MQ_HOST_1: string().required().default('127.0.0.1'),
  RABBIT_MQ_UI_PORT_1: number().required().default(15672),
  RABBIT_MQ_PORT_1: number().required().default(5672),
  RABBIT_NODE_NAME_1: string().required().default('rabbit@rabbit1-101'),

  RABBIT_MQ_HOST_2: string(),
  RABBIT_MQ_UI_PORT_2: number(),
  RABBIT_MQ_PORT_2: number(),
  RABBIT_NODE_NAME_2: string(),

  RABBIT_MQ_USER: string().required(),
  RABBIT_MQ_PASSWORD: string().required(),

  LOG_LEVEL: string()
    .oneOf(["error", "warn", "info", "http", "verbose", "debug", "silly"])
    .required(),
});

const parsed = schema.validateSync(config);

console.log("Parsed Config:", parsed);

export const {
  MISSION_CONTROL_HOST,
  RABBIT_MQ_HOST,
  AMR,
  MISSION_CONTROL_PORT,
  ROS_BRIDGE_URL,
  IFACE_NAME,
  DEBUG_LOGGER,
  HEARTBEAT_LOGGER,
  MAC,
  RABBIT_MQ_HOST_1,
  RABBIT_MQ_UI_PORT_1,
  RABBIT_MQ_PORT_1,
  RABBIT_NODE_NAME_1,
  RABBIT_MQ_HOST_2,
  RABBIT_MQ_UI_PORT_2,
  RABBIT_MQ_PORT_2,
  RABBIT_NODE_NAME_2,

  RABBIT_MQ_USER,
  RABBIT_MQ_PASSWORD,
  LOG_LEVEL
} = parsed;
