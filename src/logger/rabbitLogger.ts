import chalk from 'chalk';
import * as path from 'path';
import { createLogger, transports, format } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { kenmecLogs } from '~/helpers/system';

const LOG_LEVEL = 'info';
const AMR_ID_COLOR = chalk.green;
const NORMAL = chalk.hex('#deffc8');
const WRANG = chalk.hex('#fecf89');
const DEBUG = chalk.hex('#bad1ff');
const ERROR = chalk.hex("#ff5e5e");
const SILENT = false;

const getPath = (fileName) => {
    const time = new Date();
    const date = `${time.getFullYear()}-${time.getMonth() + 1}-${time.getDate()}`;
    return path.join(kenmecLogs, `/rabbit/${fileName}/%DATE%.log`);
};

const reduceFloatPrecision = (key: string, val: number) => {
    return val && val.toFixed ? Number(val.toFixed(3)) : val;
};

const RabbitNormalFormatter =
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
                `${isLog ? AMR_ID_COLOR('rabbitmq'.padEnd(8, " ")) : 'rabbitmq'.padEnd(8, " ")} ` +
                `${isLog ? NORMAL('[info]') : '[info]'} (${type}) - ` +
                `${input.message} ` +
                `${Object.keys(meta).length
                    ? JSON.stringify(meta, reduceFloatPrecision)
                    : ''
                }`
            );
        };

const RabbitDebugFormatter =
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
                `${isLog ? AMR_ID_COLOR('rabbitmq'.padEnd(8, " ")) : 'rabbitmq'.padEnd(8, " ")} ` +
                `${isLog ? DEBUG('[message]') : '[message]'} (${type}) - ` +
                `${input.message} ` +
                `${Object.keys(meta).length
                    ? JSON.stringify(meta, reduceFloatPrecision)
                    : ''
                }`
            );
        };

const RabbitBindingFormatter =
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
                `${isLog ? AMR_ID_COLOR('rabbitmq'.padEnd(8, " ")) : 'rabbitmq'.padEnd(8, " ")} ` +
                `${isLog ? DEBUG('[binding]') : '[binding]'} (${type}) - ` +
                `${input.message} ` +
                `${Object.keys(meta).length
                    ? JSON.stringify(meta, reduceFloatPrecision)
                    : ''
                }`
            );
        };

const RabbitNormalFormatterWrong =
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
                `${isLog ? AMR_ID_COLOR('rabbitmq'.padEnd(8, " ")) : 'rabbitmq'.padEnd(8, " ")} ` +
                `${isLog ? WRANG('[warn]') : '[warn]'} (${type}) - ` +
                `${input.message} ` +
                `${Object.keys(meta).length
                    ? JSON.stringify(meta, reduceFloatPrecision)
                    : ''
                }`
            );
        };

const RabbitNormalFormatterError =
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
                `${isLog ? AMR_ID_COLOR('rabbitmq'.padEnd(8, " ")) : 'rabbitmq'.padEnd(8, " ")} ` +
                `${isLog ? ERROR('[error]') : '[error]'} (${type}) - ` +
                `${input.message} ` +
                `${Object.keys(meta).length
                    ? JSON.stringify(meta, reduceFloatPrecision)
                    : ''
                }`
            );
        };


const dailyReportNormal: DailyRotateFile = new DailyRotateFile({
    filename: getPath('Rabbit_report'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '3d',
    format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
        format.printf(RabbitNormalFormatter(false)),
    ),
    silent: SILENT,
});

const dailyReportTransaction: DailyRotateFile = new DailyRotateFile({
    filename: getPath('transaction'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '3d',
    format: format.combine(
        format.metadata(),
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
        format.printf(RabbitNormalFormatter(false)),
    ),
    silent: SILENT,
});

export const RabbitLoggerDebug = (silent: boolean) => {
    return createLogger({
        level: LOG_LEVEL,
        transports: [
            new transports.Console({
                format: format.combine(
                    format.metadata(),
                    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                    format.printf(RabbitDebugFormatter(true)),
                ),
                silent: !silent,
            }),
            dailyReportTransaction,
        ],
    });
};

export const RabbitLoggerBindingDebug = (silent: boolean) => {
    return createLogger({
        level: LOG_LEVEL,
        transports: [
            new transports.Console({
                format: format.combine(
                    format.metadata(),
                    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                    format.printf(RabbitBindingFormatter(true)),
                ),
                silent: !silent,
            }),
        ],
    });
};

export const RabbitLoggerNormal = createLogger({
    level: LOG_LEVEL,
    transports: [
        new transports.Console({
            format: format.combine(
                format.metadata(),
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format.printf(RabbitNormalFormatter(true)),
            ),
            silent: SILENT,
        }),
        dailyReportNormal,
    ],
});

export const RabbitLoggerNormalWarning = createLogger({
    level: 'warn',
    transports: [
        new transports.Console({
            format: format.combine(
                format.metadata(),
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format.printf(RabbitNormalFormatterWrong(true)),
            ),
            silent: SILENT,
        }),
        dailyReportNormal,
    ],
});

export const RabbitLoggerNormalError = createLogger({
    level: 'error',
    transports: [
        new transports.Console({
            format: format.combine(
                format.metadata(),
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                format.printf(RabbitNormalFormatterError(true)),
            ),
            silent: SILENT,
        }),
        dailyReportNormal,
    ],
});
