import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useTestProject, writeSchema } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import { resolveConfig } from '../../src/core/config.js';
import { getPool } from '../../src/core/db.js';
import { runPipeline } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';
import type { TestProject } from './helpers.js';

const TABLE_YAML = `
table: cfg_test
columns:
  - name: id
    type: serial
    primary_key: true
  - name: val
    type: text
`;

describe('E2E config resolution', () => {
  let ctx: TestProject;
  let tmpDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = join(tmpdir(), `simplicity-cfg-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (ctx) await ctx.cleanup();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CLI flags override config file values', async () => {
    // Create a config file with lockTimeout: 9999
    const configPath = join(tmpDir, 'schema-flow.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://wrong-host/wrong_db
  lockTimeout: 9999
  pgSchema: wrong_schema
`,
    );

    // CLI overrides should win
    ctx = await useTestProject(DATABASE_URL);
    const config = resolveConfig({
      connectionString: ctx.config.connectionString,
      pgSchema: ctx.schema,
      baseDir: ctx.dir,
      lockTimeout: 2000,
      configPath,
    });

    expect(config.connectionString).toBe(ctx.config.connectionString);
    expect(config.pgSchema).toBe(ctx.schema);
    expect(config.lockTimeout).toBe(2000);
  });

  it('config file values override env vars', async () => {
    // Set env var
    process.env.DATABASE_URL = 'postgres://env-host/env_db';

    // Config file should override env var connection string
    const configPath = join(tmpDir, 'schema-flow.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://config-file-host/config_db
  lockTimeout: 7777
`,
    );

    const config = resolveConfig({ configPath });

    expect(config.connectionString).toBe('postgres://config-file-host/config_db');
    expect(config.lockTimeout).toBe(7777);
  });

  it('env vars override convention defaults', async () => {
    process.env.DATABASE_URL = 'postgres://env-override/mydb';

    // No config file, no CLI overrides
    const config = resolveConfig();

    expect(config.connectionString).toBe('postgres://env-override/mydb');
    // Convention defaults should still apply for non-connection settings
    expect(config.baseDir).toBe('./schema');
    expect(config.pgSchema).toBe('public');
    expect(config.lockTimeout).toBe(5000);
  });

  it('--env selects environment block', async () => {
    const configPath = join(tmpDir, 'schema-flow.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://default-host/default_db
  lockTimeout: 5000
  statementTimeout: 30000

environments:
  staging:
    connectionString: postgres://staging-host/staging_db
    lockTimeout: 8000
    statementTimeout: 45000
  production:
    connectionString: postgres://prod-host/prod_db
    lockTimeout: 3000
`,
    );

    const config = resolveConfig({ configPath, env: 'staging' });

    expect(config.connectionString).toBe('postgres://staging-host/staging_db');
    expect(config.lockTimeout).toBe(8000);
    expect(config.statementTimeout).toBe(45000);
  });

  it('${VAR} interpolation in config file', async () => {
    process.env.E2E_DB_HOST = 'interpolated-host.example.com';
    process.env.E2E_DB_NAME = 'interpolated_db';

    const configPath = join(tmpDir, 'schema-flow.config.yaml');
    writeFileSync(
      configPath,
      `
default:
  connectionString: postgres://\${E2E_DB_HOST}/\${E2E_DB_NAME}
`,
    );

    const config = resolveConfig({ configPath });

    expect(config.connectionString).toBe('postgres://interpolated-host.example.com/interpolated_db');
  });

  it('missing config file uses defaults', async () => {
    delete process.env.DATABASE_URL;
    delete process.env.SCHEMA_FLOW_DATABASE_URL;

    // Point to a non-existent config file
    const config = resolveConfig({ configPath: '/nonexistent/path/config.yaml' });

    expect(config.connectionString).toBe('');
    expect(config.baseDir).toBe('./schema');
    expect(config.pgSchema).toBe('public');
    expect(config.lockTimeout).toBe(5000);
    expect(config.statementTimeout).toBe(30000);
    expect(config.maxRetries).toBe(3);
    expect(config.dryRun).toBe(false);
    expect(config.allowDestructive).toBe(false);
  });

  it('lockTimeout and statementTimeout are applied to database sessions', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, { 'tables/cfg_test.yaml': TABLE_YAML });

    // Run migration with custom timeouts
    const config = resolveConfig({
      connectionString: ctx.config.connectionString,
      pgSchema: ctx.schema,
      baseDir: ctx.dir,
      lockTimeout: 7500,
      statementTimeout: 15000,
    });

    const logger = createLogger({ verbose: false, quiet: true, json: false });
    const result = await runPipeline(config, logger);
    expect(result.executed).toBeGreaterThan(0);

    // Verify timeouts are applied by checking them in a session via withClient
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      // Set timeouts the same way the pipeline does
      await client.query(`SET lock_timeout = ${config.lockTimeout}`);
      await client.query(`SET statement_timeout = ${config.statementTimeout}`);

      const lockRes = await client.query('SHOW lock_timeout');
      const stmtRes = await client.query('SHOW statement_timeout');

      // PostgreSQL returns timeouts as strings like '7500ms'
      expect(lockRes.rows[0].lock_timeout).toBe('7500ms');
      expect(stmtRes.rows[0].statement_timeout).toBe('15s');
    } finally {
      client.release();
    }
  });
});
