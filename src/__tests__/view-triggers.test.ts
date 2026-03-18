import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseView } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { getExistingViews } from '../introspect/index.js';
import type { ViewSchema } from '../schema/types.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_view_trig_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  // Create a base table and trigger function for the view triggers
  await client.query(`
    CREATE TABLE ${TEST_SCHEMA}.users (
      id serial PRIMARY KEY,
      email text NOT NULL,
      name text,
      active boolean DEFAULT true
    )
  `);
  await client.query(`
    CREATE FUNCTION ${TEST_SCHEMA}.fn_insert_active_user() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO ${TEST_SCHEMA}.users (email, name, active) VALUES (NEW.email, NEW.name, true);
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`
    CREATE FUNCTION ${TEST_SCHEMA}.fn_update_active_user() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE ${TEST_SCHEMA}.users SET email = NEW.email, name = NEW.name WHERE id = OLD.id;
      RETURN NEW;
    END;
    $$
  `);
  await client.query(`
    CREATE FUNCTION ${TEST_SCHEMA}.fn_delete_active_user() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE ${TEST_SCHEMA}.users SET active = false WHERE id = OLD.id;
      RETURN OLD;
    END;
    $$
  `);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`);
  client.release();
  await pool.end();
});

function emptyActual(): ActualState {
  return {
    tables: new Map(),
    enums: new Map(),
    functions: new Map(),
    views: new Map(),
    materializedViews: new Map(),
    roles: new Map(),
    extensions: [],
  };
}

function emptyDesired(): DesiredState {
  return {
    tables: [],
    enums: [],
    functions: [],
    views: [],
    materializedViews: [],
    roles: [],
    extensions: null,
  };
}

describe('view trigger parsing', () => {
  it('parses triggers in view YAML', () => {
    const yaml = `
name: active_users
query: |
  SELECT id, email, name FROM users WHERE active = true
triggers:
  - name: trg_insert_active_users
    timing: INSTEAD OF
    events: [INSERT]
    function: fn_insert_active_user
    for_each: ROW
`;
    const view = parseView(yaml) as ViewSchema;
    expect(view.triggers).toBeDefined();
    expect(view.triggers).toHaveLength(1);
    expect(view.triggers![0].name).toBe('trg_insert_active_users');
    expect(view.triggers![0].timing).toBe('INSTEAD OF');
    expect(view.triggers![0].events).toEqual(['INSERT']);
    expect(view.triggers![0].function).toBe('fn_insert_active_user');
    expect(view.triggers![0].for_each).toBe('ROW');
  });

  it('parses multiple triggers on a view', () => {
    const yaml = `
name: active_users
query: |
  SELECT id, email, name FROM users WHERE active = true
triggers:
  - name: trg_insert
    timing: INSTEAD OF
    events: [INSERT]
    function: fn_insert_active_user
    for_each: ROW
  - name: trg_delete
    timing: INSTEAD OF
    events: [DELETE]
    function: fn_delete_active_user
    for_each: ROW
`;
    const view = parseView(yaml) as ViewSchema;
    expect(view.triggers).toHaveLength(2);
    expect(view.triggers![0].name).toBe('trg_insert');
    expect(view.triggers![1].name).toBe('trg_delete');
  });

  it('view without triggers has no triggers field', () => {
    const yaml = `
name: simple_view
query: |
  SELECT 1 AS val
`;
    const view = parseView(yaml) as ViewSchema;
    expect(view.triggers).toBeUndefined();
  });
});

describe('view trigger planning', () => {
  it('creates INSTEAD OF trigger on new view', () => {
    const yaml = `
name: active_users
query: |
  SELECT id, email, name FROM users WHERE active = true
triggers:
  - name: trg_insert_active_users
    timing: INSTEAD OF
    events: [INSERT]
    function: fn_insert_active_user
    for_each: ROW
`;
    const view = parseView(yaml) as ViewSchema;
    const desired = emptyDesired();
    desired.views.push(view);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    const triggerOp = plan.operations.find((op) => op.type === 'create_trigger');
    expect(triggerOp).toBeDefined();
    expect(triggerOp!.sql).toContain('INSTEAD OF');
    expect(triggerOp!.sql).toContain('INSERT');
    expect(triggerOp!.sql).toContain(`"${TEST_SCHEMA}"."active_users"`);
    expect(triggerOp!.sql).toContain('fn_insert_active_user');
  });

  it('detects trigger function change and recreates trigger', () => {
    const view: ViewSchema = {
      name: 'active_users',
      query: 'SELECT id, email, name FROM users WHERE active = true',
      triggers: [
        {
          name: 'trg_insert_active_users',
          timing: 'INSTEAD OF',
          events: ['INSERT'],
          function: 'fn_update_active_user', // changed function
          for_each: 'ROW',
        },
      ],
    };

    const existingView: ViewSchema = {
      name: 'active_users',
      query: 'SELECT id, email, name FROM users WHERE active = true',
      triggers: [
        {
          name: 'trg_insert_active_users',
          timing: 'INSTEAD OF',
          events: ['INSERT'],
          function: 'fn_insert_active_user', // original function
          for_each: 'ROW',
        },
      ],
    };

    const desired = emptyDesired();
    desired.views.push(view);

    const actual = emptyActual();
    actual.views.set('active_users', existingView);

    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA });

    // Should have drop + create trigger operations
    const dropOps = plan.operations.filter(
      (op) => op.type === 'drop_trigger' && op.objectName.includes('trg_insert_active_users'),
    );
    const createOps = plan.operations.filter(
      (op) => op.type === 'create_trigger' && op.objectName.includes('trg_insert_active_users'),
    );
    expect(dropOps).toHaveLength(1);
    expect(createOps).toHaveLength(1);
  });

  it('drops trigger when removed from YAML (destructive)', () => {
    const view: ViewSchema = {
      name: 'active_users',
      query: 'SELECT id, email, name FROM users WHERE active = true',
      // No triggers
    };

    const existingView: ViewSchema = {
      name: 'active_users',
      query: 'SELECT id, email, name FROM users WHERE active = true',
      triggers: [
        {
          name: 'trg_insert_active_users',
          timing: 'INSTEAD OF',
          events: ['INSERT'],
          function: 'fn_insert_active_user',
          for_each: 'ROW',
        },
      ],
    };

    const desired = emptyDesired();
    desired.views.push(view);

    const actual = emptyActual();
    actual.views.set('active_users', existingView);

    // Without --allow-destructive, should be blocked
    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA, allowDestructive: false });
    const blockedDrops = plan.blocked.filter(
      (op) => op.type === 'drop_trigger' && op.objectName.includes('trg_insert_active_users'),
    );
    expect(blockedDrops).toHaveLength(1);

    // With --allow-destructive, should be in operations
    const plan2 = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA, allowDestructive: true });
    const dropOps = plan2.operations.filter(
      (op) => op.type === 'drop_trigger' && op.objectName.includes('trg_insert_active_users'),
    );
    expect(dropOps).toHaveLength(1);
  });

  it('is idempotent when trigger already matches', () => {
    const view: ViewSchema = {
      name: 'active_users',
      query: 'SELECT id, email, name FROM users WHERE active = true',
      triggers: [
        {
          name: 'trg_insert_active_users',
          timing: 'INSTEAD OF',
          events: ['INSERT'],
          function: 'fn_insert_active_user',
          for_each: 'ROW',
        },
      ],
    };

    const desired = emptyDesired();
    desired.views.push(view);

    // Actual state has same view with same trigger
    const actual = emptyActual();
    actual.views.set('active_users', { ...view });

    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA });

    // Should not have any trigger operations (view CREATE OR REPLACE is always emitted)
    const triggerOps = plan.operations.filter((op) => op.type === 'create_trigger' || op.type === 'drop_trigger');
    expect(triggerOps).toHaveLength(0);
  });

  it('views without triggers are backward compatible', () => {
    const view: ViewSchema = {
      name: 'simple_view',
      query: 'SELECT 1 AS val',
    };

    const desired = emptyDesired();
    desired.views.push(view);

    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });
    const viewOp = plan.operations.find((op) => op.type === 'create_view');
    expect(viewOp).toBeDefined();

    const triggerOps = plan.operations.filter((op) => op.type === 'create_trigger' || op.type === 'drop_trigger');
    expect(triggerOps).toHaveLength(0);
  });
});

describe('view trigger execution (end-to-end)', () => {
  it('creates an INSTEAD OF trigger on a view and executes it', async () => {
    // Create the view
    await client.query(`
      CREATE OR REPLACE VIEW ${TEST_SCHEMA}.active_users AS
      SELECT id, email, name FROM ${TEST_SCHEMA}.users WHERE active = true
    `);

    const yaml = `
name: active_users
query: |
  SELECT id, email, name FROM ${TEST_SCHEMA}.users WHERE active = true
triggers:
  - name: trg_insert_active_users
    timing: INSTEAD OF
    events: [INSERT]
    function: fn_insert_active_user
    for_each: ROW
`;
    const view = parseView(yaml) as ViewSchema;
    const desired = emptyDesired();
    desired.views.push(view);

    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    // Execute the trigger creation ops
    const triggerOps = plan.operations.filter((op) => op.type === 'create_trigger');
    expect(triggerOps).toHaveLength(1);
    for (const op of triggerOps) {
      await client.query(op.sql);
    }

    // Now inserting through the view should work via the INSTEAD OF trigger
    await client.query(`INSERT INTO ${TEST_SCHEMA}.active_users (email, name) VALUES ('test@example.com', 'Test')`);

    const result = await client.query(`SELECT * FROM ${TEST_SCHEMA}.users WHERE email = 'test@example.com'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].active).toBe(true);
  });

  it('introspects view triggers from the database', async () => {
    // The view and trigger were created in the previous test
    const views = await getExistingViews(client, TEST_SCHEMA);
    const activeUsersView = views.find((v) => v.name === 'active_users');
    expect(activeUsersView).toBeDefined();
    expect(activeUsersView!.triggers).toBeDefined();
    expect(activeUsersView!.triggers).toHaveLength(1);
    expect(activeUsersView!.triggers![0].name).toBe('trg_insert_active_users');
    expect(activeUsersView!.triggers![0].timing).toBe('INSTEAD OF');
    expect(activeUsersView!.triggers![0].events).toContain('INSERT');
    expect(activeUsersView!.triggers![0].function).toBe('fn_insert_active_user');
  });
});
