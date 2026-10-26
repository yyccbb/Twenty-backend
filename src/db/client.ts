import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/** A transaction: a Drizzle handle plus raw SQL on the same connection (used by pg-boss to enqueue jobs atomically). */
export interface Tx {
  db: Db;
  executeSql(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface Database {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString, max });
  return {
    pool,
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}

export async function transaction<T>(database: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const tx: Tx = {
      db: drizzle({ client, schema }),
      executeSql: (text, values) => client.query(text, values as any[]),
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Serialises calendar and ledger writes per user for the rest of the transaction. */
export async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.executeSql('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
}
