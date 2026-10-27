import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { rewardRules } from '../db/schema.js';
import type { RewardRule } from '../rules/index.js';

export interface VersionedRewardRule extends RewardRule {
  version: number;
}

function toRule(row: typeof rewardRules.$inferSelect): VersionedRewardRule {
  return {
    version: row.version,
    tokensPerBar: row.tokensPerBar,
    earlyBarRate: Number(row.earlyBarRate),
    extendedBarRate: Number(row.extendedBarRate),
    autoFinishDeductionBars: row.autoFinishDeductionBars,
  };
}

/** The newest `reward_rules` row is the active one. New versions are added by migrate.ts from the fixture constants (or by SQL), never edited. */
export async function getActiveRewardRule(db: Db): Promise<VersionedRewardRule> {
  const [row] = await db.select().from(rewardRules).orderBy(desc(rewardRules.version)).limit(1);
  if (!row) throw new Error('No reward_rules row; run migrations');
  return toRule(row);
}

export async function getRewardRule(db: Db, version: number): Promise<VersionedRewardRule> {
  const [row] = await db.select().from(rewardRules).where(eq(rewardRules.version, version));
  if (!row) throw new Error(`reward_rules version ${version} not found`);
  return toRule(row);
}
