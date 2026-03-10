import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { useTestProject, writeSchema, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';
import {
  scaffoldInit,
  scaffoldPre,
  scaffoldPost,
  scaffoldMixin,
  generateFromDb,
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  introspectTable,
} from '../../src/index.js';
import { getPool } from '../../src/core/db.js';

// ─── Scaffold tests ────────────────────────────────────────────

describe('E2E: Scaffold', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // (1) scaffoldInit creates directory structure
  it('(1) scaffoldInit creates directory structure', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const schemaDir = path.join(ctx.dir, 'schema');

    scaffoldInit(schemaDir);

    const expected = ['tables', 'enums', 'functions', 'views', 'roles', 'mixins', 'pre', 'post'];
    for (const sub of expected) {
      expect(fs.existsSync(path.join(schemaDir, sub))).toBe(true);
      expect(fs.statSync(path.join(schemaDir, sub)).isDirectory()).toBe(true);
    }
  });

  // (2) scaffoldPre creates timestamped pre-script
  it('(2) scaffoldPre creates timestamped pre-script', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const schemaDir = path.join(ctx.dir, 'schema');
    scaffoldInit(schemaDir);

    const filePath = scaffoldPre(schemaDir, 'add-extension');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toMatch(/pre\/\d{14}_add-extension\.sql$/);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('Pre-migration script');
    expect(content).toContain('add-extension');
  });

  // (3) scaffoldPost creates timestamped post-script
  it('(3) scaffoldPost creates timestamped post-script', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const schemaDir = path.join(ctx.dir, 'schema');
    scaffoldInit(schemaDir);

    const filePath = scaffoldPost(schemaDir, 'seed-data');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toMatch(/post\/\d{14}_seed-data\.sql$/);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('Post-migration script');
    expect(content).toContain('seed-data');
  });

  // (4) scaffoldMixin creates mixin template
  it('(4) scaffoldMixin creates mixin template', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const schemaDir = path.join(ctx.dir, 'schema');
    scaffoldInit(schemaDir);

    const filePath = scaffoldMixin(schemaDir, 'timestamps');

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toMatch(/mixins\/timestamps\.yaml$/);

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(content);
    expect(parsed.mixin).toBe('timestamps');
    expect(parsed.columns).toBeInstanceOf(Array);
    expect(parsed.columns.length).toBeGreaterThan(0);
  });
});

// ─── Generate tests ────────────────────────────────────────────

describe('E2E: Generate from DB', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  // (5) generateFromDb produces YAML for existing table
  it('(5) generateFromDb produces YAML for existing table with columns, indexes, constraints', async () => {
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
    default: "0"
indexes:
  - columns: [name]
    unique: true
checks:
  - name: price_positive
    expression: "price >= 0"
`,
    });

    await ctx.migrate();

    // Introspect the table from DB
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      const table = await introspectTable(client, 'products', ctx.schema);

      const files = generateFromDb({
        tables: [table],
        enums: [],
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
      });

      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('tables/products.yaml');

      const parsed = parseYaml(files[0].content);
      expect(parsed.table).toBe('products');

      // Columns match
      const colNames = parsed.columns.map((c: { name: string }) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('name');
      expect(colNames).toContain('price');

      // Indexes present
      expect(parsed.indexes).toBeDefined();
      expect(parsed.indexes.length).toBeGreaterThanOrEqual(1);

      // Checks present
      expect(parsed.checks).toBeDefined();
      expect(parsed.checks.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });

  // (6) generateFromDb produces YAML for enum
  it('(6) generateFromDb produces YAML for enum', async () => {
    ctx = await useTestProject(DATABASE_URL);
    // Use a unique enum name to avoid conflicts with other test runs
    const enumName = `scaffold_priority_${ctx.schema.replace('test_', '')}`;

    // Clean up any leftover from previous runs
    await queryDb(ctx, `DROP TYPE IF EXISTS "${enumName}" CASCADE`);

    writeSchema(ctx.dir, {
      [`enums/${enumName}.yaml`]: `
name: ${enumName}
values:
  - low
  - medium
  - high
  - critical
`,
      'tables/tickets.yaml': `
table: tickets
columns:
  - name: id
    type: serial
    primary_key: true
  - name: prio
    type: ${enumName}
`,
    });

    await ctx.migrate();

    // Enums are created without schema qualification, so they land in public
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      // Check both test schema and public for the enum
      let enums = await getExistingEnums(client, ctx.schema);
      if (enums.length === 0) {
        enums = await getExistingEnums(client, 'public');
        enums = enums.filter((e) => e.name === enumName);
      }

      expect(enums.length).toBeGreaterThan(0);

      const files = generateFromDb({
        tables: [],
        enums,
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
      });

      const enumFile = files.find((f) => f.filename.startsWith('enums/'));
      expect(enumFile).toBeDefined();

      const parsed = parseYaml(enumFile!.content);
      expect(parsed.name).toBe(enumName);
      expect(parsed.values).toEqual(['low', 'medium', 'high', 'critical']);
    } finally {
      client.release();
      // Clean up public-schema enum
      await queryDb(ctx, `DROP TYPE IF EXISTS "${enumName}" CASCADE`);
    }
  });

  // (7) generateFromDb produces YAML for function
  it('(7) generateFromDb produces YAML for function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/add_nums.yaml': `
name: add_nums
language: plpgsql
returns: integer
args:
  - name: a
    type: integer
  - name: b
    type: integer
body: |
  BEGIN
    RETURN a + b;
  END;
`,
    });

    await ctx.migrate();

    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      const fns = await getExistingFunctions(client, ctx.schema);
      const addFn = fns.find((f) => f.name === 'add_nums');
      expect(addFn).toBeDefined();

      const files = generateFromDb({
        tables: [],
        enums: [],
        functions: [addFn!],
        views: [],
        materializedViews: [],
        roles: [],
      });

      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('functions/add_nums.yaml');

      const parsed = parseYaml(files[0].content);
      expect(parsed.name).toBe('add_nums');
      expect(parsed.language).toBe('plpgsql');
      expect(parsed.returns).toBe('integer');
      expect(parsed.args).toHaveLength(2);
      expect(parsed.body).toContain('RETURN a + b');
    } finally {
      client.release();
    }
  });

  // (8) generateFromDb with seeds captures row data
  it('(8) generateFromDb with seeds captures row data', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/categories.yaml': `
table: categories
columns:
  - name: id
    type: serial
    primary_key: true
  - name: name
    type: text
    nullable: false
seeds:
  - id: 1
    name: Electronics
  - id: 2
    name: Books
  - id: 3
    name: Clothing
`,
    });

    await ctx.migrate();

    // Introspect — the introspected table won't have seeds,
    // but we can simulate the --seeds workflow by capturing rows
    // and attaching them to the table schema before generating
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    try {
      const table = await introspectTable(client, 'categories', ctx.schema);

      // Capture actual row data (simulating --seeds behavior)
      const rows = await client.query(`SELECT * FROM "${ctx.schema}"."categories" ORDER BY id`);
      table.seeds = rows.rows.map((r: Record<string, unknown>) => r);

      const files = generateFromDb({
        tables: [table],
        enums: [],
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
      });

      const parsed = parseYaml(files[0].content);
      expect(parsed.seeds).toBeDefined();
      expect(parsed.seeds).toHaveLength(3);
      expect(parsed.seeds[0].name).toBe('Electronics');
      expect(parsed.seeds[1].name).toBe('Books');
      expect(parsed.seeds[2].name).toBe('Clothing');
    } finally {
      client.release();
    }
  });

  // (9) Generated YAML round-trips: generate -> re-parse -> migrate to fresh DB -> drift clean
  it('(9) generated YAML round-trips with no drift', async () => {
    // Step 1: Create initial schema and migrate
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/accounts.yaml': `
table: accounts
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    nullable: false
  - name: active
    type: boolean
    default: "true"
indexes:
  - columns: [email]
    unique: true
`,
    });

    await ctx.migrate();

    // Step 2: Generate YAML from the DB
    const pool = getPool(ctx.config.connectionString);
    const client = await pool.connect();
    let generatedFiles;
    try {
      const tableNames = await getExistingTables(client, ctx.schema);
      const tables = [];
      for (const name of tableNames) {
        tables.push(await introspectTable(client, name, ctx.schema));
      }

      generatedFiles = generateFromDb({
        tables,
        enums: [],
        functions: [],
        views: [],
        materializedViews: [],
        roles: [],
      });
    } finally {
      client.release();
    }

    expect(generatedFiles.length).toBeGreaterThan(0);

    // Step 3: Write generated YAML to a new test project and migrate
    const ctx2 = await useTestProject(DATABASE_URL);
    try {
      const schemaFiles: Record<string, string> = {};
      for (const f of generatedFiles) {
        schemaFiles[f.filename] = f.content;
      }
      writeSchema(ctx2.dir, schemaFiles);

      await ctx2.migrate();

      // Step 4: Drift detection should show no differences
      // (exclude roles — they are global PG objects, not schema-scoped)
      const driftReport = await ctx2.drift();
      const driftItems = driftReport.items.filter((item) => item.status !== 'ok' && item.type !== 'role');
      expect(driftItems).toHaveLength(0);
    } finally {
      await ctx2.cleanup();
    }
  });
});
