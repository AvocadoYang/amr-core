import chalk from 'chalk';
import * as path from 'path';
import { createLogger, transports, format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { kenmecLogs } from '~/helpers/system';


const LOG_LEVEL = 'info';
const AMR_ID_COLOR = chalk.hex('#ffcefe');
const NORMAL = chalk.hex('#deffc8');
const WRANG = chalk.hex('#f17109');
const HAND_SHAKE = chalk.hex('#bad1ff');
const RX = chalk.hex('#daacff');
const ERROR = chalk.red;
const SILENT = false;

const getPath = (fileName) => {
  const time = new Date();
  const date = `${time.getFullYear()}-${time.getMonth() + 1}-${time.getDate()}`;
  return path.join(kenmecLogs, `/system/${fileName}/%DATE%.log`);
};

const reduceFloatPrecision = (key: string, val: number) => {
  return val && val.toFixed ? Number(val.toFixed(3)) : val;
};

const SysNormalFormatter =
  (isLog: boolean) =>
    (input: {
      timestamp: string;
      level: string;
      message: string;
      metadata: {
        type: string;
        status: string;
      };
    }) => {
      const meta = input.metadata;
      const { type } = meta;
      delete meta.type;
      return (
        `${isLog ? chalk.blue(input.timestamp) : input.timestamp} ` +
        `${isLog ? AMR_ID_COLOR('system') : 'system'} ` +
        `${isLog ? NORMAL('[normal]') : '[normal]'} (${type}) - ` +
        `${input.message} ` +
        `${Object.keys(meta).length
          ? JSON.stringify(meta, reduceFloatPrecision)
          : ''
        }`
      );
    };

const SysNormalFormatterWrong =
  (isLog: boolean) =>
    (input: {
      timestamp: string;
      level: string;
      message: string;
      metadata: {
        type: string;
        status: string;
      };
    }) => {
      const meta = input.metadata;
      const { type } = meta;
      delete meta.type;
      return (
        `${isLog ? chalk.blue(input.timestamp) : input.timestamp} ` +
        `${isLog ? AMR_ID_COLOR('system') : 'system'} ` +
        `${isLog ? WRANG('[warn]') : '[warn]'} (${type}) - ` +
        `${input.message} ` +
        `${Object.keys(meta).length
          ? JSON.stringify(meta, reduceFloatPrecision)
          : ''
        }`
      );
    };

const SysNormalFormatterError =
  (isLog: boolean) =>
    (input: {
      timestamp: string;
      level: string;
      message: string;
      metadata: {
        type: string;
        status: string;
      };
    }) => {
      const meta = input.metadata;
      const { type } = meta;
      delete meta.type;

      return (
        `${isLog ? chalk.blue(input.timestamp) : input.timestamp} ` +
        `${isLog ? AMR_ID_COLOR('system') : 'system'} ` +
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
    format.printf(SysNormalFormatter(false)),
  ),
  silent: SILENT,
});

export const SysLoggerNormal = createLogger({
  level: LOG_LEVEL,
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(SysNormalFormatter(true)),
      ),
      silent: SILENT,
    }),
    dailyReportNormal,
  ],
});

export const SysLoggerNormalWarning = createLogger({
  level: 'warn',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(SysNormalFormatterWrong(true)),
      ),
      silent: SILENT,
    }),
    dailyReportNormal,
  ],
});

export const SysLoggerNormalError = createLogger({
  level: 'error',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(SysNormalFormatterError(true)),
      ),
      silent: SILENT,
    }),
    dailyReportNormal,
  ],
});
