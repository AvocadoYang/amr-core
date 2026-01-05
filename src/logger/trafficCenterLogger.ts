import chalk from 'chalk';
import * as path from 'path';
import { createLogger, transports, format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { kenmecLogs } from '~/helpers/system';


const LOG_LEVEL = 'info';
const AMR_ID_COLOR = chalk.green;
const NORMAL = chalk.hex('#deffc8');
const WRANG = chalk.hex('#fecf89');
const DEBUG = chalk.hex('#fdcdee');
const ERROR = chalk.hex("#ff5e5e");
const HAND_SHAKE = chalk.hex('#bad1ff');
const RX = chalk.hex('#daacff');
const SILENT = false;

const getPath = (fileName) => {
  const time = new Date();
  const date = `${time.getFullYear()}-${time.getMonth() + 1}-${time.getDate()}`;
  return path.join(kenmecLogs, `/handshake/${fileName}/%DATE%.log`);
};

const reduceFloatPrecision = (key: string, val: number) => {
  return val && val.toFixed ? Number(val.toFixed(3)) : val;
};

const TCNormalFormatter =
  (isLog: boolean) =>
    (input: {
      timestamp: string;
      level: string;
      message: string;
      metadata: {
        group: string
        type: string;
        status: string;
      };
    }) => {
      const meta = input.metadata;
      let { type, group } = meta;
      type = type ? type : "unknown"
      group = group ? group : "unknown"
      delete meta.type;
      delete meta.group
      return (
        `${isLog ? chalk.blue(input.timestamp) : input.timestamp} ` +
        `${isLog ? AMR_ID_COLOR(group.padEnd(8, " ")) : group.padEnd(8, " ")} ` +
        `${isLog ? NORMAL('[info]') : '[info]'} (${type}) - ` +
        `${input.message} ` +
        `${Object.keys(meta).length
          ? JSON.stringify(meta, reduceFloatPrecision)
          : ''
        }`
      );
    };

const TCNormalFormatterWrong =
  (isLog: boolean) =>
    (input: {
      timestamp: string;
      level: string;
      message: string;
      metadata: {
        group: string
        type: string;
        status: string;
      };
    }) => {
      const meta = input.metadata;
      const { type, group } = meta;
      delete meta.type;
      delete meta.group;
      return (
        `${isLog ? chalk.blue(input.timestamp) : input.timestamp} ` +
        `${isLog ? AMR_ID_COLOR(group.padEnd(8, " ")) : group.padEnd(8, " ")} ` +
        `${isLog ? WRANG('[warn]') : '[warn]'} (${type}) - ` +
        `${input.message} ` +
        `${Object.keys(meta).length
          ? JSON.stringify(meta, reduceFloatPrecision)
          : ''
        }`
      );
    };

const TCNormalFormatterError =
  (isLog: boolean) =>
    (input: {
      timestamp: string;
      level: string;
      message: string;
      metadata: {
        group: string
        type: string;
        status: string;
      };
    }) => {
      const meta = input.metadata;
      const { type, group } = meta;
      delete meta.type;
      delete meta.group;

      return (
        `${isLog ? chalk.blue(input.timestamp) : input.timestamp} ` +
        `${isLog ? AMR_ID_COLOR(group.padEnd(8, " ")) : group.padEnd(8, " ")} ` +
        `${isLog ? ERROR('[error]') : '[error]'} (${type}) - ` +
        `${input.message} ` +
        `${Object.keys(meta).length
          ? JSON.stringify(meta, reduceFloatPrecision)
          : ''
        }`
      );
    };

const dailyReportNormal: DailyRotateFile = new DailyRotateFile({
  filename: getPath('system_report'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '3d',
  format: format.combine(
    format.metadata(),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
    format.printf(TCNormalFormatter(false)),
  ),
  silent: SILENT,
});

export const TCLoggerNormal = createLogger({
  level: LOG_LEVEL,
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(TCNormalFormatter(true)),
      ),
      silent: SILENT,
    }),
    dailyReportNormal,
  ],
});

export const TCLoggerNormalWarning = createLogger({
  level: 'warn',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(TCNormalFormatterWrong(true)),
      ),
      silent: SILENT,
    }),
    dailyReportNormal,
  ],
});

export const TCLoggerNormalError = createLogger({
  level: 'error',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(TCNormalFormatterError(true)),
      ),
      silent: SILENT,
    }),
    dailyReportNormal,
  ],
});
