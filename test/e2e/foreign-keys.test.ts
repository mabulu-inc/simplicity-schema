import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Foreign Keys', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('creates a basic FK (references table.column)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/parents.yaml': `
table: parents
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: name
    type: text
`,
      'tables/children.yaml': `
table: children
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: parents
      column: id
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'parents');
    await assertTableExists(ctx, 'children');

    const result = await queryDb(
      ctx,
      `SELECT con.conname, a.attname AS col,
              cf.relname AS ref_table, af.attname AS ref_col
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
       JOIN pg_class cf ON cf.oid = con.confrelid
       JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = ANY(con.confkey)
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'children'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].col).toBe('parent_id');
    expect(result.rows[0].ref_table).toBe('parents');
    expect(result.rows[0].ref_col).toBe('id');
  });

  it('creates FK with on_delete CASCADE', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_cascade_parent.yaml': `
table: fk_cascade_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
      'tables/fk_cascade_child.yaml': `
table: fk_cascade_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_cascade_parent
      column: id
      on_delete: CASCADE
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT con.confdeltype
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'fk_cascade_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    // 'c' = CASCADE
    expect(result.rows[0].confdeltype).toBe('c');
  });

  it('creates FK with on_delete SET NULL', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_setnull_parent.yaml': `
table: fk_setnull_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
      'tables/fk_setnull_child.yaml': `
table: fk_setnull_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_setnull_parent
      column: id
      on_delete: SET NULL
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT con.confdeltype
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'fk_setnull_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    // 'n' = SET NULL
    expect(result.rows[0].confdeltype).toBe('n');
  });

  it('creates FK with on_update CASCADE', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_upd_parent.yaml': `
table: fk_upd_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
      'tables/fk_upd_child.yaml': `
table: fk_upd_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_upd_parent
      column: id
      on_update: CASCADE
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT con.confupdtype
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'fk_upd_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    // 'c' = CASCADE
    expect(result.rows[0].confupdtype).toBe('c');
  });

  it('creates FK with deferrable: true, initially_deferred: true', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_defer_parent.yaml': `
table: fk_defer_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
      'tables/fk_defer_child.yaml': `
table: fk_defer_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_defer_parent
      column: id
      deferrable: true
      initially_deferred: true
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT con.condeferrable, con.condeferred
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'fk_defer_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].condeferrable).toBe(true);
    expect(result.rows[0].condeferred).toBe(true);
  });

  it('creates FK with a custom constraint name', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_named_parent.yaml': `
table: fk_named_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
      'tables/fk_named_child.yaml': `
table: fk_named_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_named_parent
      column: id
      name: fk_custom_parent_ref
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'fk_named_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].conname).toBe('fk_custom_parent_ref');
  });

  it('creates a cross-schema FK reference', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create another schema and a referenced table in it
    const otherSchema = ctx.schema + '_other';
    await queryDb(ctx, `CREATE SCHEMA IF NOT EXISTS "${otherSchema}"`);
    await queryDb(
      ctx,
      `CREATE TABLE "${otherSchema}"."lookup" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text)`,
    );

    writeSchema(ctx.dir, {
      'tables/cross_schema_child.yaml': `
table: cross_schema_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: lookup_id
    type: uuid
    references:
      table: lookup
      column: id
      schema: ${otherSchema}
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'cross_schema_child');

    const result = await queryDb(
      ctx,
      `SELECT nf.nspname AS ref_schema, cf.relname AS ref_table
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       JOIN pg_class cf ON cf.oid = con.confrelid
       JOIN pg_namespace nf ON nf.oid = cf.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'cross_schema_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].ref_schema).toBe(otherSchema);
    expect(result.rows[0].ref_table).toBe('lookup');

    // Cleanup the other schema
    await queryDb(ctx, `DROP SCHEMA "${otherSchema}" CASCADE`);
  });

  it('creates FK as NOT VALID then validates it', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/fk_valid_parent.yaml': `
table: fk_valid_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
      'tables/fk_valid_child.yaml': `
table: fk_valid_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_valid_parent
      column: id
`,
    });

    await runMigration(ctx);

    // After migration, constraint should be fully validated (convalidated = true)
    const result = await queryDb(
      ctx,
      `SELECT con.conname, con.convalidated
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'fk_valid_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].convalidated).toBe(true);
  });

  it('blocks FK column drop without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create tables with FK via migration
    writeSchema(ctx.dir, {
      'tables/fk_drop_parent.yaml': `
table: fk_drop_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
`,
      'tables/fk_drop_child.yaml': `
table: fk_drop_child
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: parent_id
    type: uuid
    references:
      table: fk_drop_parent
      column: id
`,
    });

    await runMigration(ctx);

    // Step 2: Remove the FK column from schema and re-run without --allow-destructive
    writeSchema(ctx.dir, {
      'tables/fk_drop_parent.yaml': `
table: fk_drop_parent
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
      'tables/fk_drop_child.yaml': `
table: fk_drop_child
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // The parent_id column with FK should still exist because the drop was blocked
    const result = await queryDb(
      ctx,
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = cls.relnamespace
       WHERE con.contype = 'f' AND n.nspname = $1 AND cls.relname = 'fk_drop_child'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
  });
});
