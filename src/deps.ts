import type { AiProvider } from './ai/provider.js';
import type { AppleVerifier } from './auth/apple.js';
import type { Config } from './config.js';
import type { Database } from './db/client.js';
import type { JobQueue } from './jobs/queue.js';
import type { Clock } from './lib/clock.js';

/** Everything a service needs from the outside world, passed explicitly so tests can swap any of it. */
export interface Deps {
  config: Config;
  database: Database;
  clock: Clock;
  queue: JobQueue;
  apple: AppleVerifier;
  ai: AiProvider;
}
