/**
 * Server-side logger. Wraps console methods for consistent output.
 * In production, consider replacing with pino/winston for structured logging.
 */

function formatMessage(level: string, tag: string, message: string): string {
  return `[${level}] ${tag} ${message}`;
}

export const logger = {
  info(tag: string, message: string, ...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.log(formatMessage('INFO', tag, message), ...args);
  },
  warn(tag: string, message: string, ...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.warn(formatMessage('WARN', tag, message), ...args);
  },
  error(tag: string, message: string, ...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.error(formatMessage('ERROR', tag, message), ...args);
  },
  debug(tag: string, message: string, ...args: unknown[]) {
    // eslint-disable-next-line no-console
    console.log(formatMessage('DEBUG', tag, message), ...args);
  },
};
