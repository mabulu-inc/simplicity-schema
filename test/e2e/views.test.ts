import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Views', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('creates a regular view with a query', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
    nullable: false
  - name: deleted_at
    type: timestamptz
`,
      'views/active_users.yaml': `
name: active_users
query: |
  SELECT id, email
  FROM "${s}".users
  WHERE deleted_at IS NULL
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT table_name, view_definition IS NOT NULL AS has_def
       FROM information_schema.views
       WHERE table_schema = $1 AND table_name = 'active_users'`,
      [s],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].table_name).toBe('active_users');
    expect(result.rows[0].has_def).toBe(true);
  });

  it('grants SELECT on a view', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    await queryDb(
      ctx,
      `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_view_reader') THEN
        CREATE ROLE test_view_reader;
      END IF;
    END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
`,
      'views/active_users.yaml': `
name: active_users
query: |
  SELECT id, email FROM "${s}".users
grants:
  - to: test_view_reader
    privileges: [SELECT]
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT has_table_privilege('test_view_reader', '"${s}"."active_users"', 'SELECT') AS has_sel`,
    );
    expect(result.rows[0].has_sel).toBe(true);

    // Cleanup: drop schema first (CASCADE removes grants), then role
    await ctx.cleanup();
    await queryDb(ctx, 'DROP OWNED BY test_view_reader');
    await queryDb(ctx, 'DROP ROLE IF EXISTS test_view_reader');
    ctx = undefined as unknown as TestProject;
  });

  it('sets a view comment', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/users.yaml': `
table: users
columns:
  - name: id
    type: serial
    primary_key: true
  - name: email
    type: text
`,
      'views/active_users.yaml': `
name: active_users
query: |
  SELECT id, email FROM "${s}".users
comment: 'Users who have not been soft-deleted'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(c.oid) AS comment
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE c.relname = 'active_users' AND n.nspname = $1 AND c.relkind = 'v'`,
      [s],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('Users who have not been soft-deleted');
  });

  it('replaces a view when the query changes', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    // Pre-create table via SQL to avoid planner re-introspection issues on second migration
    await queryDb(ctx, `CREATE TABLE "${s}".users (id integer PRIMARY KEY, email text, name text)`);

    writeSchema(ctx.dir, {
      'views/active_users.yaml': `
name: active_users
query: |
  SELECT id, email FROM "${s}".users
`,
    });

    await runMigration(ctx);

    // Change the query to include the name column
    writeSchema(ctx.dir, {
      'views/active_users.yaml': `
name: active_users
query: |
  SELECT id, email, name FROM "${s}".users
`,
    });

    await runMigration(ctx);

    // Verify the view now has the name column
    const result = await queryDb(
      ctx,
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'active_users'
       ORDER BY ordinal_position`,
      [s],
    );
    const columns = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(columns).toContain('name');
  });

  it('creates a materialized view', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: user_id
    type: integer
    nullable: false
  - name: amount
    type: numeric
`,
      'views/order_stats.yaml': `
name: order_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM "${s}".orders
  GROUP BY user_id
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT matviewname
       FROM pg_matviews
       WHERE schemaname = $1 AND matviewname = 'order_stats'`,
      [s],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].matviewname).toBe('order_stats');
  });

  it('creates indexes on a materialized view', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: user_id
    type: integer
    nullable: false
`,
      'views/order_stats.yaml': `
name: order_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM "${s}".orders
  GROUP BY user_id
indexes:
  - columns: [user_id]
    unique: true
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT i.relname AS index_name, ix.indisunique
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON t.relnamespace = n.oid
       WHERE n.nspname = $1 AND t.relname = 'order_stats'`,
      [s],
    );
    expect(result.rowCount).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].indisunique).toBe(true);
  });

  it('grants SELECT on a materialized view', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    await queryDb(
      ctx,
      `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_view_reader') THEN
        CREATE ROLE test_view_reader;
      END IF;
    END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: user_id
    type: integer
`,
      'views/order_stats.yaml': `
name: order_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM "${s}".orders
  GROUP BY user_id
grants:
  - to: test_view_reader
    privileges: [SELECT]
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT has_table_privilege('test_view_reader', '"${s}"."order_stats"', 'SELECT') AS has_sel`,
    );
    expect(result.rows[0].has_sel).toBe(true);

    // Cleanup: drop schema first (CASCADE removes grants), then role
    await ctx.cleanup();
    await queryDb(ctx, 'DROP OWNED BY test_view_reader');
    await queryDb(ctx, 'DROP ROLE IF EXISTS test_view_reader');
    ctx = undefined as unknown as TestProject;
  });

  it('sets a materialized view comment', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: user_id
    type: integer
`,
      'views/order_stats.yaml': `
name: order_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM "${s}".orders
  GROUP BY user_id
comment: 'Aggregated user order statistics'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(c.oid) AS comment
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE c.relname = 'order_stats' AND n.nspname = $1 AND c.relkind = 'm'`,
      [s],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('Aggregated user order statistics');
  });

  it('recreates a materialized view when the query changes', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    const ordersTable = `
table: orders
columns:
  - name: id
    type: integer
    nullable: false
  - name: user_id
    type: integer
    nullable: false
  - name: amount
    type: numeric
`;

    writeSchema(ctx.dir, {
      'tables/orders.yaml': ordersTable,
      'views/order_stats.yaml': `
name: order_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM "${s}".orders
  GROUP BY user_id
`,
    });

    await runMigration(ctx);

    // Change query to include sum — keep the same table YAML
    writeSchema(ctx.dir, {
      'tables/orders.yaml': ordersTable,
      'views/order_stats.yaml': `
name: order_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count, sum(amount) AS total_amount
  FROM "${s}".orders
  GROUP BY user_id
`,
    });

    await runMigration(ctx, { allowDestructive: true });

    // Verify the matview has the new column
    const result = await queryDb(
      ctx,
      `SELECT attname
       FROM pg_attribute
       WHERE attrelid = (
         SELECT c.oid FROM pg_class c
         JOIN pg_namespace n ON c.relnamespace = n.oid
         WHERE c.relname = 'order_stats' AND n.nspname = $1
       ) AND attnum > 0 AND NOT attisdropped
       ORDER BY attnum`,
      [s],
    );
    const columns = result.rows.map((r: { attname: string }) => r.attname);
    expect(columns).toContain('total_amount');
  });

  it('verifies materialized view data with rows', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const s = ctx.schema;

    writeSchema(ctx.dir, {
      'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: serial
    primary_key: true
  - name: user_id
    type: integer
    nullable: false
  - name: amount
    type: numeric
`,
      'views/order_stats.yaml': `
name: order_stats
materialized: true
query: |
  SELECT user_id, count(*) AS order_count
  FROM "${s}".orders
  GROUP BY user_id
`,
    });

    await runMigration(ctx);

    // Insert data into the underlying table
    await queryDb(ctx, `INSERT INTO "${s}".orders (user_id, amount) VALUES (1, 100), (1, 200), (2, 50)`);

    // Refresh the materialized view so it picks up the data
    await queryDb(ctx, `REFRESH MATERIALIZED VIEW "${s}".order_stats`);

    // Query the materialized view
    const result = await queryDb(ctx, `SELECT user_id, order_count FROM "${s}".order_stats ORDER BY user_id`);
    expect(result.rowCount).toBe(2);
    expect(result.rows[0]).toEqual({ user_id: 1, order_count: '2' });
    expect(result.rows[1]).toEqual({ user_id: 2, order_count: '1' });
  });
});
