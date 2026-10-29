import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';

interface LogContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with a request (or job) ID that every log line inside it carries. */
export function withLogContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: process.env.SERVICE_NAME ?? 'twenty' },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const requestId = currentRequestId();
    return requestId ? { request_id: requestId } : {};
  },
  redact: ['req.headers.authorization', '*.refresh_token', '*.id_token', '*.access_token'],
});
