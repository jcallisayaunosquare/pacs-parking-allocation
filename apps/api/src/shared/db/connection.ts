import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import type { Database } from './schema';

/**
 * One pool per container, created outside the handler and reused across invocations.
 *
 * Max 2 connections per container: with reserved concurrency of 10 on `api` and 1–2 on
 * the jobs, the whole system stays near 25 connections — well inside a t4g.micro's
 * limit, which is what lets the pilot skip RDS Proxy (§10).
 *
 * Authentication is IAM database authentication (§10 cloud security practices): the
 * password is a signed token minted per connection and valid for 15 minutes, so no
 * database credential is stored in the function configuration, in SSM, or in git.
 * `pg` accepts an async `password` function, so each new pooled connection mints its own.
 *
 * Local development falls back to a password from the environment, which is what keeps
 * the stack runnable offline with no AWS account (NFR-14).
 */
let pool: Pool | undefined;
let db: Kysely<Database> | undefined;

interface Target {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
}

const target = (): Target => ({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'postgres',
  database: process.env.DB_NAME ?? 'pacs_dev',
});

function buildPool(): Pool {
  const t = target();
  const staticPassword = process.env.DB_PASSWORD;

  // A fresh token per connection. The SDK signs locally — no network call, so this
  // costs nothing and works from inside the VPC with no internet route.
  const signer = staticPassword
    ? undefined
    : new Signer({
        hostname: t.host,
        port: t.port,
        username: t.user,
        region: process.env.AWS_REGION ?? 'us-east-2',
      });

  return new Pool({
    host: t.host,
    port: t.port,
    user: t.user,
    database: t.database,
    password: staticPassword ?? (async () => signer!.getAuthToken()),
    max: 2,
    idleTimeoutMillis: 30_000,
    // 15s, not 8: the first invocation in a VPC pays for ENI attachment on top of the
    // TLS handshake and IAM token auth, and 8s was not enough for that cold path.
    connectionTimeoutMillis: 15_000,
    // RDS enforces TLS (rds.force_ssl), and IAM auth requires it. The CA bundle is not
    // shipped in the Lambda bundle, so the pilot encrypts without verifying the chain;
    // verify-full with the RDS global bundle is on the §28 gap list.
    ssl: process.env.DB_SSL === 'disable' ? false : { rejectUnauthorized: false },
  });
}

export async function getDb(): Promise<Kysely<Database>> {
  if (db) return db;
  pool = buildPool();
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return db;
}

/** Used by tests and by the local runner. */
export async function closeDb(): Promise<void> {
  await db?.destroy();
  db = undefined;
  pool = undefined;
}
