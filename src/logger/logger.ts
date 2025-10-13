import winston from 'winston';
import config from '~/config';

const format = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'hh:mm:ss.SSS' }),
  winston.format.json(),
  winston.format.printf((info) => {
    // const timestamp = info.timestamp as string;
    const level = info.level.padEnd(18, ' ');
    const message = (info.message as string).trim();
    return `${level} ${message}`;
  }),
);

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console({ format, level: config.LOG_LEVEL }),
  ],
});

export default logger;

/**
 * error:    unexpected
 * warn:     expected bad thing
 * info:     important procedure
 * http:     input/output
 * verbose:  step by step
 * debug:    custom thing
 * silly:    annoying stuff
 * */
