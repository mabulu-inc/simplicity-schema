import { describe, it, expect, afterEach } from 'vitest';
import { useTestProject, writeSchema, runMigration, queryDb, assertTableExists } from './helpers.js';
import { DATABASE_URL } from './setup.js';
import type { TestProject } from './helpers.js';

let counter = 0;
function uniqueRole(base: string): string {
  return `${base}_${Date.now()}_${counter++}`;
}

async function dropRoleIfExists(ctx: TestProject, roleName: string): Promise<void> {
  await queryDb(ctx, `DROP OWNED BY "${roleName}"`).catch(() => {});
  await queryDb(ctx, `DROP ROLE IF EXISTS "${roleName}"`);
}

describe('E2E: Grants and Triggers', () => {
  let ctx: TestProject;
  const rolesToCleanup: string[] = [];

  afterEach(async () => {
    if (ctx) {
      await ctx.cleanup();
      for (const role of rolesToCleanup) {
        await dropRoleIfExists(ctx, role).catch(() => {});
      }
      rolesToCleanup.length = 0;
    }
  });

  // ─── Grants ────────────────────────────────────────────────────

  it('(1) table-level SELECT grant', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('grant_select');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/g_select.yaml': `
table: g_select
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
grants:
  - to: ${roleName}
    privileges: [SELECT]
`,
    });

    await runMigration(ctx);
    await assertTableExists(ctx, 'g_select');

    const result = await queryDb(
      ctx,
      `SELECT has_table_privilege('${roleName}', '"${ctx.schema}".g_select', 'SELECT') AS has_priv`,
    );
    expect(result.rows[0].has_priv).toBe(true);

    // Should NOT have INSERT
    const noInsert = await queryDb(
      ctx,
      `SELECT has_table_privilege('${roleName}', '"${ctx.schema}".g_select', 'INSERT') AS has_priv`,
    );
    expect(noInsert.rows[0].has_priv).toBe(false);
  });

  it('(2) table-level multi-privilege grant (SELECT, INSERT, UPDATE)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('grant_multi');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/g_multi.yaml': `
table: g_multi
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
grants:
  - to: ${roleName}
    privileges: [SELECT, INSERT, UPDATE]
`,
    });

    await runMigration(ctx);

    for (const priv of ['SELECT', 'INSERT', 'UPDATE']) {
      const result = await queryDb(
        ctx,
        `SELECT has_table_privilege('${roleName}', '"${ctx.schema}".g_multi', '${priv}') AS has_priv`,
      );
      expect(result.rows[0].has_priv, `should have ${priv}`).toBe(true);
    }

    // Should NOT have DELETE
    const noDel = await queryDb(
      ctx,
      `SELECT has_table_privilege('${roleName}', '"${ctx.schema}".g_multi', 'DELETE') AS has_priv`,
    );
    expect(noDel.rows[0].has_priv).toBe(false);
  });

  it('(3) column-level grant', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('grant_col');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/g_col.yaml': `
table: g_col
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: public_data
    type: text
  - name: secret_data
    type: text
grants:
  - to: ${roleName}
    privileges: [SELECT]
    columns: [id, public_data]
`,
    });

    await runMigration(ctx);

    // Should have column-level SELECT on id and public_data
    const result = await queryDb(
      ctx,
      `SELECT has_column_privilege('${roleName}', '"${ctx.schema}".g_col', 'id', 'SELECT') AS has_id,
              has_column_privilege('${roleName}', '"${ctx.schema}".g_col', 'public_data', 'SELECT') AS has_public,
              has_column_privilege('${roleName}', '"${ctx.schema}".g_col', 'secret_data', 'SELECT') AS has_secret`,
    );
    expect(result.rows[0].has_id).toBe(true);
    expect(result.rows[0].has_public).toBe(true);
    expect(result.rows[0].has_secret).toBe(false);
  });

  it('(4) with_grant_option: true', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('grant_opt');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/g_opt.yaml': `
table: g_opt
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
grants:
  - to: ${roleName}
    privileges: [SELECT]
    with_grant_option: true
`,
    });

    await runMigration(ctx);

    // Check grantable privilege via information_schema
    const result = await queryDb(
      ctx,
      `SELECT is_grantable
       FROM information_schema.table_privileges
       WHERE table_schema = $1
         AND table_name = 'g_opt'
         AND grantee = $2
         AND privilege_type = 'SELECT'`,
      [ctx.schema, roleName],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].is_grantable).toBe('YES');
  });

  it('(5) sequence grant auto-generated for serial columns with INSERT', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('grant_seq');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'tables/g_seq.yaml': `
table: g_seq
columns:
  - name: id
    type: serial
    primary_key: true
  - name: data
    type: text
grants:
  - to: ${roleName}
    privileges: [INSERT]
`,
    });

    await runMigration(ctx);

    // The sequence for serial column should have USAGE granted
    const result = await queryDb(
      ctx,
      `SELECT has_sequence_privilege(
         '${roleName}',
         pg_get_serial_sequence('"${ctx.schema}".g_seq', 'id'),
         'USAGE'
       ) AS has_seq`,
    );
    expect(result.rows[0].has_seq).toBe(true);
  });

  it('(6) function EXECUTE grant', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('grant_exec');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'functions/g_exec_fn.yaml': `
name: g_exec_fn
language: sql
returns: integer
body: |
  SELECT 42;
grants:
  - to: ${roleName}
    privileges: [EXECUTE]
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT has_function_privilege('${roleName}', '"${ctx.schema}".g_exec_fn()', 'EXECUTE') AS has_exec`,
    );
    expect(result.rows[0].has_exec).toBe(true);
  });

  it('(7) schema grant (from extensions schema_grants)', async () => {
    ctx = await useTestProject(DATABASE_URL);
    const roleName = uniqueRole('grant_schema');
    rolesToCleanup.push(roleName);

    await queryDb(
      ctx,
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
          CREATE ROLE "${roleName}";
        END IF;
      END $$`,
    );

    writeSchema(ctx.dir, {
      'extensions.yaml': `
extensions:
  - pgcrypto
schema_grants:
  - to: ${roleName}
    schemas:
      - public
`,
    });

    await runMigration(ctx);

    const result = await queryDb(ctx, `SELECT has_schema_privilege('${roleName}', 'public', 'USAGE') AS has_usage`);
    expect(result.rows[0].has_usage).toBe(true);
  });

  // ─── Triggers ──────────────────────────────────────────────────

  it('(8) BEFORE UPDATE trigger FOR EACH ROW', async () => {
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
      'tables/t_before_upd.yaml': `
table: t_before_upd
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
  - name: updated_at
    type: timestamptz
triggers:
  - name: set_updated_at
    timing: BEFORE
    events: [UPDATE]
    function: trg_set_updated
    for_each: ROW
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT t.tgname,
              (t.tgtype::int & 2) > 0 AS is_before,
              (t.tgtype::int & 16) > 0 AS is_update,
              (t.tgtype::int & 1) > 0 AS is_row
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_before_upd'
         AND t.tgname = 'set_updated_at'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].is_before).toBe(true);
    expect(result.rows[0].is_update).toBe(true);
    expect(result.rows[0].is_row).toBe(true);
  });

  it('(9) AFTER INSERT trigger', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_after_ins.yaml': `
name: trg_after_ins
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/t_after_ins.yaml': `
table: t_after_ins
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
triggers:
  - name: after_ins_trg
    timing: AFTER
    events: [INSERT]
    function: trg_after_ins
    for_each: ROW
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT t.tgname,
              (t.tgtype::int & 2) > 0 AS is_before,
              (t.tgtype::int & 4) > 0 AS is_insert,
              (t.tgtype::int & 1) > 0 AS is_row
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_after_ins'
         AND t.tgname = 'after_ins_trg'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].is_before).toBe(false); // AFTER
    expect(result.rows[0].is_insert).toBe(true);
    expect(result.rows[0].is_row).toBe(true);
  });

  it('(10) FOR EACH STATEMENT trigger', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_stmt.yaml': `
name: trg_stmt
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NULL;
  END;
`,
      'tables/t_stmt_trg.yaml': `
table: t_stmt_trg
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
triggers:
  - name: stmt_trg
    timing: AFTER
    events: [INSERT]
    function: trg_stmt
    for_each: STATEMENT
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT t.tgname,
              (t.tgtype::int & 1) > 0 AS is_row
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_stmt_trg'
         AND t.tgname = 'stmt_trg'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].is_row).toBe(false); // STATEMENT, not ROW
  });

  it('(11) trigger with WHEN condition', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_when_fn.yaml': `
name: trg_when_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
`,
      'tables/t_when_trg.yaml': `
table: t_when_trg
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
  - name: updated_at
    type: timestamptz
triggers:
  - name: when_trg
    timing: BEFORE
    events: [UPDATE]
    function: trg_when_fn
    for_each: ROW
    when: "OLD.data IS DISTINCT FROM NEW.data"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT t.tgname,
              pg_get_triggerdef(t.oid) AS triggerdef
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_when_trg'
         AND t.tgname = 'when_trg'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    // The trigger definition should contain the WHEN clause
    expect(result.rows[0].triggerdef.toLowerCase()).toContain('when');
    expect(result.rows[0].triggerdef).toContain('DISTINCT FROM');
  });

  it('(12) trigger with multiple events [INSERT, UPDATE]', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_multi_ev.yaml': `
name: trg_multi_ev
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/t_multi_ev.yaml': `
table: t_multi_ev
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: data
    type: text
triggers:
  - name: multi_ev_trg
    timing: BEFORE
    events: [INSERT, UPDATE]
    function: trg_multi_ev
    for_each: ROW
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT t.tgname,
              (t.tgtype::int & 4) > 0 AS is_insert,
              (t.tgtype::int & 16) > 0 AS is_update
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_multi_ev'
         AND t.tgname = 'multi_ev_trg'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].is_insert).toBe(true);
    expect(result.rows[0].is_update).toBe(true);
  });

  it('(13) trigger comment', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_comment_fn.yaml': `
name: trg_comment_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/t_trg_comment.yaml': `
table: t_trg_comment
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
triggers:
  - name: commented_trg
    timing: AFTER
    events: [INSERT]
    function: trg_comment_fn
    for_each: ROW
    comment: "Audit trail trigger"
`,
    });

    await runMigration(ctx);

    const result = await queryDb(
      ctx,
      `SELECT obj_description(t.oid, 'pg_trigger') AS comment
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_trg_comment'
         AND t.tgname = 'commented_trg'`,
      [ctx.schema],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].comment).toBe('Audit trail trigger');
  });

  it('(14) trigger change triggers drop+recreate', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_change_fn.yaml': `
name: trg_change_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/t_trg_change.yaml': `
table: t_trg_change
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: data
    type: text
triggers:
  - name: change_trg
    timing: BEFORE
    events: [INSERT]
    function: trg_change_fn
    for_each: ROW
`,
    });

    await runMigration(ctx);

    // Verify initial trigger
    const before = await queryDb(
      ctx,
      `SELECT (t.tgtype::int & 4) > 0 AS is_insert,
              (t.tgtype::int & 16) > 0 AS is_update
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_trg_change'
         AND t.tgname = 'change_trg'`,
      [ctx.schema],
    );
    expect(before.rowCount).toBe(1);
    expect(before.rows[0].is_insert).toBe(true);
    expect(before.rows[0].is_update).toBe(false);

    // Change trigger from INSERT to UPDATE
    writeSchema(ctx.dir, {
      'functions/trg_change_fn.yaml': `
name: trg_change_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/t_trg_change.yaml': `
table: t_trg_change
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
  - name: data
    type: text
triggers:
  - name: change_trg
    timing: BEFORE
    events: [UPDATE]
    function: trg_change_fn
    for_each: ROW
`,
    });

    await runMigration(ctx, { allowDestructive: true });

    const after = await queryDb(
      ctx,
      `SELECT (t.tgtype::int & 4) > 0 AS is_insert,
              (t.tgtype::int & 16) > 0 AS is_update
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_trg_change'
         AND t.tgname = 'change_trg'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].is_insert).toBe(false);
    expect(after.rows[0].is_update).toBe(true);
  });

  it('(15) drop_trigger blocked without --allow-destructive', async () => {
    ctx = await useTestProject(DATABASE_URL);

    writeSchema(ctx.dir, {
      'functions/trg_nodrop_fn.yaml': `
name: trg_nodrop_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/t_nodrop_trg.yaml': `
table: t_nodrop_trg
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
triggers:
  - name: nodrop_trg
    timing: AFTER
    events: [INSERT]
    function: trg_nodrop_fn
    for_each: ROW
`,
    });

    await runMigration(ctx);

    // Verify trigger exists
    const before = await queryDb(
      ctx,
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_nodrop_trg'
         AND t.tgname = 'nodrop_trg'`,
      [ctx.schema],
    );
    expect(before.rowCount).toBe(1);

    // Remove the trigger from schema (without --allow-destructive)
    writeSchema(ctx.dir, {
      'functions/trg_nodrop_fn.yaml': `
name: trg_nodrop_fn
language: plpgsql
returns: trigger
body: |
  BEGIN
    RETURN NEW;
  END;
`,
      'tables/t_nodrop_trg.yaml': `
table: t_nodrop_trg
columns:
  - name: id
    type: uuid
    primary_key: true
    nullable: false
    default: gen_random_uuid()
`,
    });

    await runMigration(ctx);

    // Trigger should still exist because drop was blocked
    const after = await queryDb(
      ctx,
      `SELECT t.tgname
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = 't_nodrop_trg'
         AND t.tgname = 'nodrop_trg'`,
      [ctx.schema],
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0].tgname).toBe('nodrop_trg');
  });
});
