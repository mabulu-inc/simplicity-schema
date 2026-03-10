import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import { runValidate, runBaseline, getStatus, createLogger, resolveConfig } from '../../src/index.js';

function makeConfig(ctx: TestProject) {
  return resolveConfig({
    connectionString: ctx.config.connectionString,
    baseDir: ctx.dir,
    pgSchema: ctx.schema,
    allowDestructive: false,
  });
}

function makeLogger() {
  return createLogger({ verbose: false, quiet: true, json: false });
}

describe('E2E: Validate and baseline', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // ─── (1) Validate runs migration in rolled-back transaction ──

  it('(1) validate runs migration in rolled-back transaction — no objects exist after', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/widgets.yaml': `
table: widgets
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
`,
    });

    const config = makeConfig(ctx);
    const logger = makeLogger();
    const result = await runValidate(config, logger);

    // Validate should have executed operations
    expect(result.executed).toBeGreaterThan(0);
    expect(result.validated).toBe(true);

    // But the table should NOT exist (rolled back)
    const check = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'widgets'`,
      [ctx.schema],
    );
    expect(check.rowCount).toBe(0);
  });

  // ─── (2) Validate catches invalid SQL (returns error) ─────────

  it('(2) validate catches invalid SQL (returns error)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/bad_table.yaml': `
table: bad_table
columns:
  - name: id
    type: serial
    primary_key: true
  - name: ref_col
    type: integer
    references:
      table: nonexistent_table
      column: id
`,
    });

    const config = makeConfig(ctx);
    const logger = makeLogger();

    // Should throw because the referenced table doesn't exist
    await expect(runValidate(config, logger)).rejects.toThrow();
  });

  // ─── (3) Validate with valid schema succeeds ──────────────────

  it('(3) validate with valid schema succeeds', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: total
    type: numeric
    nullable: true
  - name: created_at
    type: timestamptz
    default: "now()"
`,
    });

    const config = makeConfig(ctx);
    const logger = makeLogger();
    const result = await runValidate(config, logger);

    expect(result.executed).toBeGreaterThan(0);
    expect(result.validated).toBe(true);

    // Table should NOT exist after validate
    const check = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'orders'`,
      [ctx.schema],
    );
    expect(check.rowCount).toBe(0);
  });

  // ─── (4) Baseline records files without executing migration ───

  it('(4) baseline records all files in history without executing migration', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/projects.yaml': `
table: projects
columns:
  - name: id
    type: serial
    primary_key: true
  - name: title
    type: text
`,
      'tables/tasks.yaml': `
table: tasks
columns:
  - name: id
    type: serial
    primary_key: true
  - name: project_id
    type: integer
`,
    });

    const config = makeConfig(ctx);
    const logger = makeLogger();
    const baselineResult = await runBaseline(config, logger);

    // Should have recorded files
    expect(baselineResult.filesRecorded).toBe(2);

    // But tables should NOT exist (baseline doesn't run SQL)
    const check = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'projects'`,
      [ctx.schema],
    );
    expect(check.rowCount).toBe(0);
  });

  // ─── (5) After baseline, migration detects no changes ─────────

  it('(5) after baseline on existing DB, running migration detects no changes', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: id
    type: integer
    nullable: false
  - name: email
    type: text
`,
    });

    // First migration creates the table
    await runMigration(ctx);
    await assertTableExists(ctx, 'accounts');

    const config = makeConfig(ctx);
    const logger = makeLogger();

    // Baseline records file hashes
    await runBaseline(config, logger);

    // Run migration again — the DB already matches YAML, so no operations needed
    const result = await runMigration(ctx);
    expect(result.executed).toBe(0);
  });

  // ─── (6) Baseline with --json outputs structured result ───────

  it('(6) baseline returns structured result', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
`,
    });

    const config = makeConfig(ctx);
    const logger = makeLogger();
    const result = await runBaseline(config, logger);

    // Verify the result has the expected structure
    expect(result).toHaveProperty('filesRecorded');
    expect(typeof result.filesRecorded).toBe('number');
    expect(result.filesRecorded).toBe(1);

    // Verify status reflects the baseline
    const status = await getStatus(config, logger);
    expect(status.appliedFiles).toBeGreaterThan(0);
    // No pending changes since all files are baselined
    expect(status.pendingChanges).toBe(0);
  });
});
