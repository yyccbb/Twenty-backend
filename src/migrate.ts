import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { logger } from './lib/logger.js';

/** Applies the plain-SQL migrations in src/db/migrations (copied next to dist/ in the image). */
export async function runMigrations(connectionString: string, folder = defaultFolder()) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

function defaultFolder() {
  return process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'db', 'migrations');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url);
  logger.info('migrations applied');
}
