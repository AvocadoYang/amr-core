import { number, object, string } from 'yup';
// eslint-disable-next-line no-restricted-imports
import config from 'config';
import chalk from 'chalk';
import { format } from 'util';

console.log(
  chalk.blue(
    'Load config with following files: ',
    format(config.util.getConfigSources().map((c) => c.name)),
  ),
);

const schema = object({
  MISSION_CONTROL_HOST: string().required(),
  MISSION_CONTROL_PORT: number().integer().min(0).max(65535).required(),
  ROS_BRIDGE_URL: string().required(),
  IFACE_NAME: string().required(),
  INITIAL_BATTERY_PERCENTAGE: number().min(0).max(1).required(),
  BATTERY_LIFE: number().positive().required(),
  CHARGE_TIME: number().positive().required(),
  OFFSET_X: number().min(-0.1).max(0.1).default(0),
  OFFSET_Y: number().min(-0.1).max(0.1).default(0),
  OFFSET_YAW: number().min(-0.17).max(0.17).default(0),
  LOG_LEVEL: string()
    .oneOf(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
    .required(),
});

const parsed = schema.validateSync(config);

console.log('Parsed Config:', parsed);

export default parsed;
