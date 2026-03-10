import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Indexes', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('creates a default btree index', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/btree_idx.yaml': `
table: btree_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
indexes:
  - columns: [email]
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'btree_idx');

    const result = await queryDb(
      ctx,
      `SELECT i.relname AS index_name, am.amname AS method
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'btree_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].method).toBe('btree');
  });

  it('creates a GIN index on jsonb', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/gin_idx.yaml': `
table: gin_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: metadata
    type: jsonb
indexes:
  - columns: [metadata]
    method: gin
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT am.amname AS method
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'gin_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].method).toBe('gin');
  });

  it('creates a GiST index', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Use a tsvector column which supports GiST
    writeSchema(ctx.dir, {
      'tables/gist_idx.yaml': `
table: gist_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: search_vector
    type: tsvector
indexes:
  - columns: [search_vector]
    method: gist
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT am.amname AS method
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'gist_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].method).toBe('gist');
  });

  it('creates a hash index', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/hash_idx.yaml': `
table: hash_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: code
    type: text
indexes:
  - columns: [code]
    method: hash
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT am.amname AS method
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'hash_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].method).toBe('hash');
  });

  it('creates a BRIN index', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/brin_idx.yaml': `
table: brin_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: created_at
    type: timestamptz
    default: now()
indexes:
  - columns: [created_at]
    method: brin
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT am.amname AS method
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'brin_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].method).toBe('brin');
  });

  it('creates a partial index with WHERE clause', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/partial_idx.yaml': `
table: partial_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
  - name: deleted_at
    type: timestamptz
indexes:
  - columns: [email]
    where: "deleted_at IS NULL"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT pg_get_expr(ix.indpred, ix.indrelid) AS predicate
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'partial_idx'
         AND NOT ix.indisprimary
         AND ix.indpred IS NOT NULL`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].predicate).toContain('deleted_at IS NULL');
  });

  it('creates a covering index with INCLUDE', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/covering_idx.yaml': `
table: covering_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: name
    type: text
  - name: email
    type: text
indexes:
  - columns: [name]
    include: [email]
`,
    });

    await runMigration(ctx);

    // pg_index.indnatts = total attrs, pg_index.indnkeyatts = key attrs
    // If include columns exist, indnatts > indnkeyatts
    const result = await queryDb(
      ctx,
      `SELECT ix.indnatts, ix.indnkeyatts
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'covering_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    // 1 key column + 1 include column = 2 total, 1 key
    expect(result.rows[0].indnatts).toBe(2);
    expect(result.rows[0].indnkeyatts).toBe(1);
  });

  it('creates an index with opclass (text_pattern_ops)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/opclass_idx.yaml': `
table: opclass_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: name
    type: text
indexes:
  - columns: [name]
    opclass: text_pattern_ops
`,
    });

    await runMigration(ctx);

    // Check the index definition contains text_pattern_ops
    const result = await queryDb(
      ctx,
      `SELECT indexdef
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'opclass_idx'
         AND indexname != 'opclass_idx_pkey'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].indexdef).toContain('text_pattern_ops');
  });

  it('creates a unique index', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/unique_idx.yaml': `
table: unique_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
indexes:
  - columns: [email]
    unique: true
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT ix.indisunique
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'unique_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].indisunique).toBe(true);
  });

  it('creates an index with a custom name', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/named_idx.yaml': `
table: named_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
indexes:
  - name: idx_custom_email
    columns: [email]
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'named_idx'
         AND indexname != 'named_idx_pkey'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].indexname).toBe('idx_custom_email');
  });

  it('creates an index with a comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/commented_idx.yaml': `
table: commented_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
indexes:
  - columns: [email]
    comment: "Speed up email lookups"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(i.oid) AS comment
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'commented_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('Speed up email lookups');
  });

  it('creates multiple indexes on one table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/multi_idx.yaml': `
table: multi_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
  - name: name
    type: text
  - name: created_at
    type: timestamptz
    default: now()
indexes:
  - columns: [email]
    unique: true
  - columns: [name]
  - columns: [created_at]
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT i.relname AS index_name
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'multi_idx'
         AND NOT ix.indisprimary
       ORDER BY i.relname`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(3);
  });

  it('blocks index drop without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create table with an index
    writeSchema(ctx.dir, {
      'tables/drop_idx.yaml': `
table: drop_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
indexes:
  - columns: [email]
`,
    });

    await runMigration(ctx);

    // Verify index exists
    const before = await queryDb(
      ctx,
      `SELECT i.relname AS index_name
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'drop_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(before.rowCount).toBe(1);

    // Step 2: Remove the index from schema (keep columns) and run without --allow-destructive
    writeSchema(ctx.dir, {
      'tables/drop_idx.yaml': `
table: drop_idx
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
`,
    });

    await runMigration(ctx);

    // Index should still exist because the drop was blocked
    const after = await queryDb(
      ctx,
      `SELECT i.relname AS index_name
       FROM pg_index ix
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'drop_idx'
         AND NOT ix.indisprimary`,
      [ctx.schema],
    );

    expect(after.rowCount).toBe(1);
  });
});
