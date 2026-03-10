import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Prechecks', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('(1) passing precheck — query returns truthy, migration proceeds', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
prechecks:
  - name: always_true
    query: 'SELECT true'
    message: 'This should never fail'
`,
    });

    const result = await runMigration(ctx);
    expect(result.executed).toBeGreaterThan(0);
    await assertTableExists(ctx, 'items');
  });

  it('(2) failing precheck — query returns falsy, migration aborts with message', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/widgets.yaml': `
table: widgets
columns:
  - name: id
    type: integer
    primary_key: true
prechecks:
  - name: always_false
    query: 'SELECT false'
    message: 'Widgets cannot be created yet'
`,
    });

    await expect(runMigration(ctx)).rejects.toThrow('Widgets cannot be created yet');

    // Table should NOT have been created
    const result = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'widgets'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(0);
  });

  it('(3) multiple prechecks — all must pass', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/multi.yaml': `
table: multi
columns:
  - name: id
    type: integer
    primary_key: true
prechecks:
  - name: check_one
    query: 'SELECT true'
    message: 'Check one failed'
  - name: check_two
    query: 'SELECT false'
    message: 'Check two failed'
`,
    });

    // Second precheck fails, so migration should abort
    await expect(runMigration(ctx)).rejects.toThrow('Check two failed');

    // Table should NOT have been created
    const result = await queryDb(
      ctx,
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'multi'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(0);
  });

  it('(4) precheck on existing table — not just new tables', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // First, create the table without prechecks
    const ordersYaml = `
table: orders
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: status
    type: text
    nullable: false
`;
    writeSchema(ctx.dir, { 'tables/orders.yaml': ordersYaml });

    await runMigration(ctx);
    await assertTableExists(ctx, 'orders');

    // Insert a row so the precheck query has data to validate against
    await queryDb(ctx, `INSERT INTO "${ctx.schema}".orders (id, status) VALUES (1, 'active')`);

    // Now re-run with a precheck that queries the existing table's data
    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: status
    type: text
    nullable: false
prechecks:
  - name: no_null_status
    query: 'SELECT count(*) = 0 FROM ${ctx.schema}.orders WHERE status IS NULL'
    message: 'Orders with null status exist — fix before migrating'
`,
    });

    // Precheck should pass (the existing row has a non-null status)
    const result = await runMigration(ctx);
    // Precheck ran successfully (no error thrown)
    expect(result).toBeDefined();
  });
});
