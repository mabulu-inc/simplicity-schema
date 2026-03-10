import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

describe('E2E: Functions', () => {
  let ctx: TestProject;

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  it('creates a basic plpgsql trigger function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/update_timestamp.yaml': `
name: update_timestamp
language: plpgsql
returns: trigger
body: |
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.proname, l.lanname, p.prorettype::regtype::text AS returns
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       JOIN pg_language l ON p.prolang = l.oid
       WHERE n.nspname = $1 AND p.proname = 'update_timestamp'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].proname).toBe('update_timestamp');
    expect(result.rows[0].lanname).toBe('plpgsql');
    expect(result.rows[0].returns).toBe('trigger');
  });

  it('creates a SQL language function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/add_numbers.yaml': `
name: add_numbers
language: sql
returns: integer
args:
  - name: a
    type: integer
  - name: b
    type: integer
body: |
  SELECT a + b;
`,
    });

    await runMigration(ctx);

    // Verify by calling the function
    const result = await queryDb(ctx, `SELECT "${ctx.schema}".add_numbers(3, 4) AS sum`);
    expect(result.rows[0].sum).toBe(7);
  });

  it('creates a function with VARIADIC args', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/concat_all.yaml': `
name: concat_all
language: sql
returns: text
args:
  - name: separator
    type: text
    mode: IN
  - name: parts
    type: text[]
    mode: VARIADIC
body: |
  SELECT array_to_string(parts, separator);
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT "${ctx.schema}".concat_all('-', 'a', 'b', 'c') AS joined`);
    expect(result.rows[0].joined).toBe('a-b-c');
  });

  it('creates a function with a default argument', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/greet.yaml': `
name: greet
language: sql
returns: text
args:
  - name: greeting
    type: text
    default: "'Hello'"
body: |
  SELECT greeting || ' world';
`,
    });

    await runMigration(ctx);

    // Call with explicit arg
    const r1 = await queryDb(ctx, `SELECT "${ctx.schema}".greet('Hi') AS msg`);
    expect(r1.rows[0].msg).toBe('Hi world');

    // Call with default
    const r2 = await queryDb(ctx, `SELECT "${ctx.schema}".greet() AS msg`);
    expect(r2.rows[0].msg).toBe('Hello world');
  });

  it('creates a function with security definer', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/secure_fn.yaml': `
name: secure_fn
language: sql
returns: integer
security: definer
body: |
  SELECT 1;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.prosecdef
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'secure_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].prosecdef).toBe(true);
  });

  it('creates a function with security invoker', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/invoker_fn.yaml': `
name: invoker_fn
language: sql
returns: integer
security: invoker
body: |
  SELECT 1;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.prosecdef
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'invoker_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].prosecdef).toBe(false);
  });

  it('creates a stable function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/stable_fn.yaml': `
name: stable_fn
language: sql
returns: integer
volatility: stable
body: |
  SELECT 42;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.provolatile
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'stable_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].provolatile).toBe('s'); // s=stable, i=immutable, v=volatile
  });

  it('creates an immutable function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/immutable_fn.yaml': `
name: immutable_fn
language: sql
returns: integer
volatility: immutable
body: |
  SELECT 42;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.provolatile
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'immutable_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].provolatile).toBe('i');
  });

  it('creates a function with parallel safe', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/par_safe_fn.yaml': `
name: par_safe_fn
language: sql
returns: integer
parallel: safe
body: |
  SELECT 1;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.proparallel
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'par_safe_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].proparallel).toBe('s'); // s=safe, r=restricted, u=unsafe
  });

  it('creates a function with parallel restricted', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/par_restricted_fn.yaml': `
name: par_restricted_fn
language: sql
returns: integer
parallel: restricted
body: |
  SELECT 1;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.proparallel
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'par_restricted_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].proparallel).toBe('r');
  });

  it('creates a strict function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/strict_fn.yaml': `
name: strict_fn
language: sql
returns: integer
strict: true
args:
  - name: x
    type: integer
body: |
  SELECT x * 2;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.proisstrict
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'strict_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].proisstrict).toBe(true);

    // STRICT function should return NULL when given NULL input
    const nullResult = await queryDb(ctx, `SELECT "${ctx.schema}".strict_fn(NULL) AS val`);
    expect(nullResult.rows[0].val).toBeNull();
  });

  it('creates a leakproof function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/leakproof_fn.yaml': `
name: leakproof_fn
language: sql
returns: integer
leakproof: true
volatility: immutable
body: |
  SELECT 1;
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.proleakproof
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'leakproof_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].proleakproof).toBe(true);
  });

  it('creates a function with cost and rows', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/costly_fn.yaml': `
name: costly_fn
language: sql
returns: SETOF integer
cost: 500
rows: 50
body: |
  SELECT generate_series(1, 50);
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.procost, p.prorows
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'costly_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].procost).toBe(500);
    expect(result.rows[0].prorows).toBe(50);
  });

  it('creates a function with SET configuration params', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/config_fn.yaml': `
name: config_fn
language: sql
returns: text
set:
  search_path: public
body: |
  SELECT current_setting('search_path');
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT p.proconfig
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'config_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].proconfig).toContain('search_path=public');
  });

  it('grants EXECUTE on a function', async () => {
    ctx = await useTestProject(DATABASE_URL);

    // Create a role for the grant test
    await queryDb(
      ctx,
      `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_fn_user') THEN
        CREATE ROLE test_fn_user;
      END IF;
    END $$`,
    );
    ctx.registerRole('test_fn_user');

    writeSchema(ctx.dir, {
      'functions/granted_fn.yaml': `
name: granted_fn
language: sql
returns: integer
body: |
  SELECT 1;
grants:
  - to: test_fn_user
    privileges: [EXECUTE]
`,
    });

    await runMigration(ctx);

    // Verify the grant via has_function_privilege
    const result = await queryDb(
      ctx,
      `SELECT has_function_privilege('test_fn_user', '"${ctx.schema}".granted_fn()', 'EXECUTE') AS has_exec`,
    );
    expect(result.rows[0].has_exec).toBe(true);
  });

  it('sets a function comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/commented_fn.yaml': `
name: commented_fn
language: sql
returns: integer
body: |
  SELECT 1;
comment: 'This function does very little'
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(p.oid) AS comment
       FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = $1 AND p.proname = 'commented_fn'`,
      [ctx.schema],
    );
    expect(result.rows[0].comment).toBe('This function does very little');
  });

  it('function body change triggers recreate', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/mutable_fn.yaml': `
name: mutable_fn
language: sql
returns: integer
body: |
  SELECT 1;
`,
    });

    await runMigration(ctx);

    // Verify initial behavior
    const r1 = await queryDb(ctx, `SELECT "${ctx.schema}".mutable_fn() AS val`);
    expect(r1.rows[0].val).toBe(1);

    // Change the body
    writeSchema(ctx.dir, {
      'functions/mutable_fn.yaml': `
name: mutable_fn
language: sql
returns: integer
body: |
  SELECT 99;
`,
    });

    await runMigration(ctx);

    // Verify updated behavior
    const r2 = await queryDb(ctx, `SELECT "${ctx.schema}".mutable_fn() AS val`);
    expect(r2.rows[0].val).toBe(99);
  });
});
