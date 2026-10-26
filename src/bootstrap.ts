import { JoseAppleVerifier } from './auth/apple.js';
import { createAiProvider } from './ai/index.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import type { Deps } from './deps.js';
import type { JobQueue } from './jobs/queue.js';
import { systemClock } from './lib/clock.js';

export function buildDeps(queue: JobQueue, config = loadConfig()): Deps {
  return {
    config,
    database: createDatabase(config.DATABASE_URL, config.DATABASE_POOL_MAX),
    clock: systemClock,
    queue,
    apple: new JoseAppleVerifier(config.APPLE_CLIENT_IDS),
    ai: createAiProvider(config),
  };
}
