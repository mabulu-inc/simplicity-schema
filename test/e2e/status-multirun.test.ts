import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, assertTableExists, assertColumnExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import { getStatus } from '../../src/cli/pipeline.js';
import { createLogger } from '../../src/core/logger.js';
import type { TestProject } from './helpers.js';

const logger = createLogger({ verbose: false, quiet: true, json: false });

describe('E2E status command', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('shows no applied files on fresh database', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
`,
    });

    const status = await getStatus(ctx.config, logger);

    expect(status.appliedFiles).toBe(0);
    expect(status.history).toHaveLength(0);
    expect(status.pendingChanges).toBe(1);
  });

  it('shows applied files with correct metadata after migration', async () => {
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
    nullable: false
`,
    });

    await runMigration(ctx);
    const status = await getStatus(ctx.config, logger);

    expect(status.appliedFiles).toBeGreaterThan(0);
    expect(status.pendingChanges).toBe(0);
    expect(status.history.length).toBeGreaterThan(0);

    const entry = status.history[0];
    expect(entry.filePath).toBeDefined();
    expect(entry.phase).toBeDefined();
    expect(entry.appliedAt).toBeInstanceOf(Date);
  });

  it('shows pending changes after file modification', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: label
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);

    // Verify clean status
    let status = await getStatus(ctx.config, logger);
    expect(status.pendingChanges).toBe(0);

    // Modify the file
    writeSchema(ctx.dir, {
      'tables/items.yaml': `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: label
    type: text
    nullable: false
  - name: description
    type: text
    nullable: true
`,
    });

    status = await getStatus(ctx.config, logger);
    expect(status.pendingChanges).toBe(1);
  });
});

describe('E2E multi-run behavior', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('idempotent re-run produces no operations on second run', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/products.yaml': `
table: products
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
  - name: price
    type: numeric
    nullable: true
`,
    });

    const firstRun = await runMigration(ctx);
    expect(firstRun.executed).toBeGreaterThan(0);

    const secondRun = await runMigration(ctx);
    expect(secondRun.executed).toBe(0);
  });

  it('additive change adds only new column on second run', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/customers.yaml': `
table: customers
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'customers');
    await assertColumnExists(ctx, 'customers', 'email');

    // Add a column
    writeSchema(ctx.dir, {
      'tables/customers.yaml': `
table: customers
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    nullable: false
  - name: phone
    type: text
    nullable: true
`,
    });

    const secondRun = await runMigration(ctx);
    expect(secondRun.executed).toBeGreaterThan(0);

    await assertColumnExists(ctx, 'customers', 'phone');

    // Status should be clean after second run
    const status = await getStatus(ctx.config, logger);
    expect(status.pendingChanges).toBe(0);
  });

  it('full lifecycle: create -> modify -> verify -> drift clean across 3 runs', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Run 1: Create table
    writeSchema(ctx.dir, {
      'tables/projects.yaml': `
table: projects
columns:
  - name: id
    type: serial
    primary_key: true
  - name: title
    type: text
    nullable: false
`,
    });

    const run1 = await runMigration(ctx);
    expect(run1.executed).toBeGreaterThan(0);
    await assertTableExists(ctx, 'projects');

    let status = await getStatus(ctx.config, logger);
    expect(status.pendingChanges).toBe(0);
    expect(status.appliedFiles).toBeGreaterThan(0);

    // Run 2: Modify table — add column
    writeSchema(ctx.dir, {
      'tables/projects.yaml': `
table: projects
columns:
  - name: id
    type: serial
    primary_key: true
  - name: title
    type: text
    nullable: false
  - name: due_date
    type: date
    nullable: true
`,
    });

    status = await getStatus(ctx.config, logger);
    expect(status.pendingChanges).toBe(1);

    const run2 = await runMigration(ctx);
    expect(run2.executed).toBeGreaterThan(0);
    await assertColumnExists(ctx, 'projects', 'due_date');

    status = await getStatus(ctx.config, logger);
    expect(status.pendingChanges).toBe(0);

    // Run 3: No changes — verify idempotent
    const run3 = await runMigration(ctx);
    expect(run3.executed).toBe(0);

    status = await getStatus(ctx.config, logger);
    expect(status.pendingChanges).toBe(0);

    // Verify no missing or extra tables (structural drift)
    const driftReport = await ctx.drift();
    const missingInDb = driftReport.items.filter((i) => i.type === 'table' && i.status === 'missing_in_db');
    const missingInYaml = driftReport.items.filter((i) => i.type === 'table' && i.status === 'missing_in_yaml');
    expect(missingInDb).toHaveLength(0);
    expect(missingInYaml).toHaveLength(0);
  });
});
