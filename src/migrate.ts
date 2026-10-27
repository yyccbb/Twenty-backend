import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { logger } from './lib/logger.js';
import { DEFAULT_REWARD_RULE, type RewardRule } from './rules/index.js';

/**
 * Applies the plain-SQL migrations in src/db/migrations (copied next to dist/ in the image), then makes
 * sure the active reward rule matches the fixture constants.
 */
export async function runMigrations(connectionString: string, folder = defaultFolder()) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: folder });
    await syncRewardRule(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Adds a new `reward_rules` version when the fixture's reward constants differ from the newest row.
 * Rows are never edited, so ledger entries keep pointing at the rule they were paid with.
 */
export async function syncRewardRule(pool: pg.Pool, r: RewardRule = DEFAULT_REWARD_RULE) {
  const { rows } = await pool.query<{ version: number }>(
    `WITH latest AS (SELECT * FROM reward_rules ORDER BY version DESC LIMIT 1)
     INSERT INTO reward_rules (version, tokens_per_bar, early_bar_rate, extended_bar_rate, auto_finish_deduction_bars)
     SELECT COALESCE((SELECT version FROM latest), 0) + 1, $1::int, $2::numeric, $3::numeric, $4::int
     WHERE NOT EXISTS (
       SELECT 1 FROM latest
       WHERE tokens_per_bar = $1::int AND early_bar_rate = $2::numeric
         AND extended_bar_rate = $3::numeric AND auto_finish_deduction_bars = $4::int)
     RETURNING version`,
    [r.tokensPerBar, r.earlyBarRate, r.extendedBarRate, r.autoFinishDeductionBars],
  );
  if (rows[0]) logger.info({ version: rows[0].version, rule: r }, 'reward rule updated from fixture constants');
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
