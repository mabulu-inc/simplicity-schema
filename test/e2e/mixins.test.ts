import { describe, it, expect, afterEach } from 'vitest';
import {
  useTestProject,
  writeSchema,
  runMigration,
  queryDb,
  assertTableExists,
  assertColumnExists,
} from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

let counter = 0;
function uniqueRole(base: string): string {
  return `${base}_${Date.now()}_${counter++}`;
}

describe('E2E: Mixins', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('(1) mixin with columns merged into table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'mixins/timestamps.yaml': `
mixin: timestamps
columns:
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
  - name: updated_at
    type: timestamptz
    nullable: false
    default: now()
`,
      'tables/orders.yaml': `
table: orders
mixins:
  - timestamps
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: total
    type: numeric
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'orders');
    await assertColumnExists(ctx, 'orders', 'id');
    await assertColumnExists(ctx, 'orders', 'total');
    await assertColumnExists(ctx, 'orders', 'created_at');
    await assertColumnExists(ctx, 'orders', 'updated_at');

    // Verify column types
    const result = await queryDb(
      ctx,
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'orders'
       ORDER BY ordinal_position`,
      [ctx.schema],
    );
    const cols = result.rows.map((r: { column_name: string }) => r.column_name);
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  it('(2) mixin with indexes merged', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'mixins/searchable.yaml': `
mixin: searchable
columns:
  - name: search_text
    type: text
indexes:
  - columns: [search_text]
    name: idx_{table}_search
`,
      'tables/articles.yaml': `
table: articles
mixins:
  - searchable
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: title
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'articles');
    await assertColumnExists(ctx, 'articles', 'search_text');

    // Verify index exists with {table} substituted
    const result = await queryDb(
      ctx,
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'articles'
         AND indexname = 'idx_articles_search'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
  });

  it('(3) mixin with triggers merged and {table} placeholder substituted', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_set_updated.yaml': `
name: trg_set_updated
language: plpgsql
returns: trigger
body: |
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
`,
      'mixins/auto_updated.yaml': `
mixin: auto_updated
columns:
  - name: updated_at
    type: timestamptz
    nullable: false
    default: now()
triggers:
  - name: trg_{table}_updated
    timing: BEFORE
    events: [UPDATE]
    function: trg_set_updated
    for_each: ROW
`,
      'tables/products.yaml': `
table: products
mixins:
  - auto_updated
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: name
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'products');

    // Verify trigger with substituted name
    const result = await queryDb(
      ctx,
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'products'
         AND t.tgname = 'trg_products_updated'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
  });

  it('(4) mixin with policies and grants merged', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('mixin_role');
    ctx.registerRole(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'mixins/secured.yaml': `
mixin: secured
policies:
  - name: "{table}_owner_policy"
    for: SELECT
    to: ${roleName}
    using: "true"
grants:
  - to: ${roleName}
    privileges: [SELECT]
`,
      'tables/accounts.yaml': `
table: accounts
mixins:
  - secured
rls: true
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: owner_id
    type: uuid
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'accounts');

    // Verify policy with substituted name
    const polResult = await queryDb(
      ctx,
      `SELECT polname
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'accounts'
         AND p.polname = 'accounts_owner_policy'`,
      [ctx.schema],
    );
    expect(polResult.rowCount).toBe(1);

    // Verify grant
    const grantResult = await queryDb(
      ctx,
      `SELECT has_table_privilege('${roleName}', '"${ctx.schema}".accounts', 'SELECT') AS has_priv`,
    );
    expect(grantResult.rows[0].has_priv).toBe(true);
  });

  it('(5) mixin with rls: true enables RLS on consuming table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'mixins/rls_mixin.yaml': `
mixin: rls_mixin
rls: true
`,
      'tables/secure_items.yaml': `
table: secure_items
mixins:
  - rls_mixin
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'secure_items');

    const result = await queryDb(
      ctx,
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'secure_items'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  it('(6) multiple mixins applied to same table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'mixins/timestamps2.yaml': `
mixin: timestamps2
columns:
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
  - name: updated_at
    type: timestamptz
    nullable: false
    default: now()
`,
      'mixins/soft_delete.yaml': `
mixin: soft_delete
columns:
  - name: deleted_at
    type: timestamptz
  - name: is_deleted
    type: boolean
    nullable: false
    default: "false"
indexes:
  - columns: [is_deleted]
    name: idx_{table}_deleted
`,
      'tables/posts.yaml': `
table: posts
mixins:
  - timestamps2
  - soft_delete
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: body
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'posts');

    // Verify columns from both mixins
    await assertColumnExists(ctx, 'posts', 'created_at');
    await assertColumnExists(ctx, 'posts', 'updated_at');
    await assertColumnExists(ctx, 'posts', 'deleted_at');
    await assertColumnExists(ctx, 'posts', 'is_deleted');

    // Verify index from soft_delete mixin with {table} substituted
    const result = await queryDb(
      ctx,
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'posts'
         AND indexname = 'idx_posts_deleted'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
  });

  it('(7) table column overrides mixin column of same name', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'mixins/with_status.yaml': `
mixin: with_status
columns:
  - name: status
    type: text
    nullable: true
    default: "'pending'"
`,
      'tables/tasks.yaml': `
table: tasks
mixins:
  - with_status
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: status
    type: text
    nullable: false
    default: "'active'"
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'tasks');

    // The table's column definition should win — NOT NULL
    const result = await queryDb(
      ctx,
      `SELECT is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'tasks' AND column_name = 'status'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].is_nullable).toBe('NO');
    // Default should be from the table definition
    expect(result.rows[0].column_default).toContain('active');
  });

  it('(8) mixin with checks merged', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'mixins/positive_amount.yaml': `
mixin: positive_amount
columns:
  - name: amount
    type: numeric
    nullable: false
checks:
  - name: chk_{table}_positive_amount
    expression: "amount > 0"
`,
      'tables/payments.yaml': `
table: payments
mixins:
  - positive_amount
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: description
    type: text
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'payments');
    await assertColumnExists(ctx, 'payments', 'amount');

    // Verify check constraint with substituted name
    const result = await queryDb(
      ctx,
      `SELECT conname
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname = $1 AND cl.relname = 'payments'
         AND c.contype = 'c'
         AND c.conname = 'chk_payments_positive_amount'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);

    // Verify the constraint actually works — negative value should fail
    await expect(
      queryDb(
        ctx,
        `INSERT INTO "${ctx.schema}".payments (id, amount, description) VALUES (gen_random_uuid(), -5, 'bad')`,
      ),
    ).rejects.toThrow();
  });
});
