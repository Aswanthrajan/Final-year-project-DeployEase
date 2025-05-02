const winston = require('winston');
const { combine, timestamp, printf, colorize } = winston.format;
const fs = require('fs');
const path = require('path');

// Ensure logs directory exists in the correct location
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Custom log formats
const consoleFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

const fileFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  handleExceptions: true,
  handleRejections: true,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true })
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        consoleFormat
      ),
      handleExceptions: true
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'deployease.log'),
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3
    })
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logDir, 'exceptions.log')
    })
  ]
});

// Add stream for HTTP logging
logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

// Add startup log
logger.info(`Logger initialized in ${process.env.NODE_ENV || 'development'} mode`);
logger.info(`Log files stored in: ${logDir}`);

module.exports = logger;