/**
 * The database user the Lambdas connect as.
 *
 * `pacs_app` authenticates with an IAM token rather than a password (§10), and holds
 * only `app_user` — so it can read and write the operational tables but cannot UPDATE
 * or DELETE allocation_history. The audit trail survives a compromised application
 * credential, which is the whole point of BR-05.
 *
 * `rds_iam` exists only on RDS, so the grant is guarded: the same migration runs
 * against a plain local Postgres (NFR-14) and simply skips that step.
 */
import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands: undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pacs_app') THEN
        CREATE ROLE pacs_app LOGIN;
      END IF;

      -- RDS-only: lets the role authenticate with a signed IAM token.
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
        GRANT rds_iam TO pacs_app;
      END IF;

      GRANT app_user TO pacs_app;
    END
    $$;

    GRANT CONNECT ON DATABASE pacs_dev TO pacs_app;
    GRANT USAGE ON SCHEMA public TO pacs_app;

    -- Tables created by later migrations inherit the same grants.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO app_user;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(/* sql */ `
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM app_user;
    REVOKE CONNECT ON DATABASE pacs_dev FROM pacs_app;
    DROP ROLE IF EXISTS pacs_app;
  `);
}
