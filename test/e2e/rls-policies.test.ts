import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: RLS Policies', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('enables RLS on a table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_basic.yaml': `
table: rls_basic
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
rls: true
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'rls_basic');

    const result = await queryDb(
      ctx,
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_basic'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  it('enables force_rls on a table', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_force.yaml': `
table: rls_force
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
rls: true
force_rls: true
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_force'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].relrowsecurity).toBe(true);
    expect(result.rows[0].relforcerowsecurity).toBe(true);
  });

  it('creates a permissive SELECT policy with USING expression', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_permissive.yaml': `
table: rls_permissive
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: own_rows
    for: SELECT
    to: PUBLIC
    using: "owner = current_user"
    permissive: true
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT polname, polpermissive, polcmd,
              pg_get_expr(polqual, polrelid) AS using_expr
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_permissive'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].polname).toBe('own_rows');
    expect(result.rows[0].polpermissive).toBe(true);
    expect(result.rows[0].polcmd).toBe('r'); // 'r' = SELECT
    expect(result.rows[0].using_expr).toContain('owner');
  });

  it('creates a restrictive policy (permissive: false)', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_restrictive.yaml': `
table: rls_restrictive
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: active
    type: boolean
    default: "true"
rls: true
policies:
  - name: active_only
    for: SELECT
    to: PUBLIC
    using: "active = true"
    permissive: false
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT polname, polpermissive
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_restrictive'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].polname).toBe('active_only');
    expect(result.rows[0].polpermissive).toBe(false);
  });

  it('creates a policy with CHECK expression', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_check.yaml': `
table: rls_check
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: insert_own
    for: INSERT
    to: PUBLIC
    check: "owner = current_user"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT polname,
              pg_get_expr(polwithcheck, polrelid) AS check_expr
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_check'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].polname).toBe('insert_own');
    expect(result.rows[0].check_expr).toContain('owner');
  });

  it('creates a policy for ALL commands', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_all.yaml': `
table: rls_all
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: all_own
    for: ALL
    to: PUBLIC
    using: "owner = current_user"
    check: "owner = current_user"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT polname, polcmd
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_all'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].polname).toBe('all_own');
    expect(result.rows[0].polcmd).toBe('*'); // '*' = ALL
  });

  it('creates a policy with a specific role', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'roles/app_role.yaml': `
role: rls_app_role
login: false
`,
      'tables/rls_role.yaml': `
table: rls_role
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
rls: true
policies:
  - name: role_policy
    for: SELECT
    to: rls_app_role
    using: "true"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT polname, polroles::regrole[]
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_role'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].polname).toBe('role_policy');
  });

  it('creates a policy with a comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'tables/rls_comment.yaml': `
table: rls_comment
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: commented_policy
    for: SELECT
    to: PUBLIC
    using: "owner = current_user"
    comment: "Users can only see their own rows"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(p.oid, 'pg_policy') AS comment
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_comment'
         AND p.polname = 'commented_policy'`,
      [ctx.schema],
    );

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('Users can only see their own rows');
  });

  it('policy change triggers drop+recreate', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create initial policy
    writeSchema(ctx.dir, {
      'tables/rls_change.yaml': `
table: rls_change
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: change_policy
    for: SELECT
    to: PUBLIC
    using: "owner = current_user"
`,
    });

    await runMigration(ctx);

    // Verify initial policy
    const before = await queryDb(
      ctx,
      `SELECT pg_get_expr(polqual, polrelid) AS using_expr
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_change'
         AND p.polname = 'change_policy'`,
      [ctx.schema],
    );

    expect(before.rowCount).toBe(1);
    expect(before.rows[0].using_expr).toContain('owner');

    // Step 2: Change the policy's USING expression
    writeSchema(ctx.dir, {
      'tables/rls_change.yaml': `
table: rls_change
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: change_policy
    for: SELECT
    to: PUBLIC
    using: "true"
`,
    });

    await runMigration(ctx);

    // Verify the policy was recreated with new expression
    const after = await queryDb(
      ctx,
      `SELECT pg_get_expr(polqual, polrelid) AS using_expr
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_change'
         AND p.polname = 'change_policy'`,
      [ctx.schema],
    );

    expect(after.rowCount).toBe(1);
    expect(after.rows[0].using_expr).toBe('true');
  });

  it('blocks disable_rls without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create table with RLS enabled
    writeSchema(ctx.dir, {
      'tables/rls_disable.yaml': `
table: rls_disable
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: data
    type: text
rls: true
`,
    });

    await runMigration(ctx);

    // Verify RLS is enabled
    const before = await queryDb(
      ctx,
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_disable'`,
      [ctx.schema],
    );
    expect(before.rows[0].relrowsecurity).toBe(true);

    // Step 2: Remove rls from schema (disable it) without --allow-destructive
    writeSchema(ctx.dir, {
      'tables/rls_disable.yaml': `
table: rls_disable
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: data
    type: text
`,
    });

    await runMigration(ctx);

    // RLS should still be enabled because disable was blocked
    const after = await queryDb(
      ctx,
      `SELECT relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_disable'`,
      [ctx.schema],
    );
    expect(after.rows[0].relrowsecurity).toBe(true);
  });

  it('blocks drop_policy without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Step 1: Create table with a policy
    writeSchema(ctx.dir, {
      'tables/rls_drop_pol.yaml': `
table: rls_drop_pol
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
policies:
  - name: drop_me
    for: SELECT
    to: PUBLIC
    using: "owner = current_user"
`,
    });

    await runMigration(ctx);

    // Verify policy exists
    const before = await queryDb(
      ctx,
      `SELECT polname
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_drop_pol'`,
      [ctx.schema],
    );
    expect(before.rowCount).toBe(1);
    expect(before.rows[0].polname).toBe('drop_me');

    // Step 2: Remove policy from schema without --allow-destructive
    writeSchema(ctx.dir, {
      'tables/rls_drop_pol.yaml': `
table: rls_drop_pol
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: owner
    type: text
rls: true
`,
    });

    await runMigration(ctx);

    // Policy should still exist because drop was blocked
    const after = await queryDb(
      ctx,
      `SELECT polname
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 'rls_drop_pol'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].polname).toBe('drop_me');
  });
});
