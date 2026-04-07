import chalk from 'chalk';
import * as path from 'path';
import { DEBUG_LOGGER, HEARTBEAT_LOGGER } from "../configs"
import { createLogger, transports, format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { kenmecLogs } from '~/helpers/system';

const AMR_ID_COLOR = chalk.green;
const NORMAL = chalk.hex('#deffc8');
const WRANG = chalk.hex('#fecf89');
const AMR_TRANSACTION = chalk.hex('#bad1ff');
const ECS_TRANSACTION = chalk.hex('#ccadc2')
const HEARTBEAT = chalk.hex("#c491a8")
const DEBUG = chalk.hex('#fdcdee');
const ERROR = chalk.hex("#ff5e5e");
const SILENT = false;

const getPath = (c_path: string) => {
  const time = new Date();
  return path.join(kenmecLogs, `/amrcore/log${c_path}/%DATE%.log`);
}

const reduceFloatPrecision = (key: string, val: number) => {
  return val && val.toFixed ? Number(val.toFixed(3)) : val;
};

const logFormatter = (isLog: boolean, level: "INFO" | "WARN" | "ERROR" | "DEBUG" | "ECS_TRANSACTION" | "AMR_TRANSACTION" | "ECS_HEARTBEAT" | "AMR_HEARTBEAT") => {
  return (input: {
    timestamp: string;
    level: string;
    message: string;
    metadata: {
      title: string;
      type: string;
      amrId: string;
      status: string;
    }
  }) => {
    const meta = input.metadata;
    let { amrId, type, title } = meta;
    title = amrId ? "" : title;
    let s = 'unknown'
    if (title || amrId) {
      s = !amrId ? title : amrId
    }
    delete meta.amrId;
    delete meta.type;
    delete meta.title;
    const levelSelector = (level) => {
      switch (level) {
        case "INFO":
          return NORMAL(`[${level}]`);
        case "WARN":
          return WRANG(`[${level}]`);
        case "ERROR":
          return ERROR(`[${level}]`);
        case "AMR_TRANSACTION":
          return AMR_TRANSACTION(`[${level}]`);
        case "AMR_HEARTBEAT":
          return HEARTBEAT(`[${level}]`);
        case "DEBUG":
          return DEBUG(`[${level}]`)
        default:
          return "unknown";
      }
    }
    return (
      `${isLog ? chalk.blue(input.timestamp) : input.timestamp} ` +
      `${isLog ? AMR_ID_COLOR(s) : s} | ` +
      `${isLog ? levelSelector(level) : `[${level}]`} (${type}) - ` +
      `${input.message} ` +
      `${Object.keys(meta).length
        ? JSON.stringify(meta, reduceFloatPrecision)
        : ''
      }`
    )
  }
}

const setDailyReport = (level: "INFO" | "WARN" | "ERROR" | "DEBUG" | "AMR_TRANSACTION" | "AMR_HEARTBEAT", path: string = "", maxSize: string = "1g", maxFiles = "7d",) => {
  return new DailyRotateFile({
    filename: getPath(path),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: maxSize,
    maxFiles: maxFiles,
    format: format.combine(
      format.metadata(),
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
      format.printf(logFormatter(false, level)),
    ),
    silent: SILENT,
  });
}

export const infoLogger = createLogger({
  level: 'info',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(logFormatter(true, "INFO")),
      ),
      silent: SILENT,
    }),
    setDailyReport("INFO"),
  ],
});

export const warnLogger = createLogger({
  level: 'warn',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(logFormatter(true, "WARN")),
      ),
      silent: SILENT,
    }),
    setDailyReport("WARN"),
  ],
});

export const errorLogger = createLogger({
  level: 'error',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(logFormatter(true, "ERROR")),
      ),
      silent: SILENT,
    }),
    setDailyReport("ERROR"),
  ],
});


export const rb_transactionLogger = createLogger({
  level: 'info',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(logFormatter(true, "AMR_TRANSACTION")),
      ),
      silent: SILENT,
    }),
    setDailyReport("AMR_TRANSACTION"),
  ],
});


export const rb_heartbeatLogger = createLogger({
  level: 'info',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(logFormatter(true, "AMR_HEARTBEAT")),
      ),
      silent: !HEARTBEAT_LOGGER,
    }),
    setDailyReport("AMR_HEARTBEAT", "/heartbeat", "200m"),
  ],
});


export const debugLogger = createLogger({
  level: 'info',
  transports: [
    new transports.Console({
      format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(logFormatter(true, "DEBUG")),
      ),
      silent: !DEBUG_LOGGER,
    }),
  ],
});


