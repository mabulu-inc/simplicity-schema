import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import type { MaterializedViewSchema } from '../schema/types.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_idempotent_mv_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  // Create a base table for the materialized view to query
  await client.query(`CREATE TABLE ${TEST_SCHEMA}.items (id serial PRIMARY KEY, name text NOT NULL)`);
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

describe('idempotent materialized view creation', () => {
  it('generates CREATE MATERIALIZED VIEW IF NOT EXISTS in the SQL for new mat views', () => {
    const mv: MaterializedViewSchema = {
      name: 'items_summary',
      materialized: true,
      query: 'SELECT count(*) AS total FROM items',
    };
    const desired: DesiredState = { ...emptyDesired(), materializedViews: [mv] };
    const actual = emptyActual();
    const plan = buildPlan(desired, actual);
    const createOp = plan.operations.find((o) => o.type === 'create_materialized_view');
    expect(createOp).toBeDefined();
    expect(createOp!.sql).toMatch(/CREATE MATERIALIZED VIEW IF NOT EXISTS/);
  });

  it('generates IF NOT EXISTS when recreating after query change', () => {
    const mv: MaterializedViewSchema = {
      name: 'items_summary',
      materialized: true,
      query: 'SELECT count(*) AS total FROM items',
    };
    const existingMv: MaterializedViewSchema = {
      name: 'items_summary',
      materialized: true,
      query: 'SELECT count(*) AS cnt FROM items',
    };
    const desired: DesiredState = { ...emptyDesired(), materializedViews: [mv] };
    const actual: ActualState = {
      ...emptyActual(),
      materializedViews: new Map([['items_summary', existingMv]]),
    };
    const plan = buildPlan(desired, actual);
    const createOp = plan.operations.find((o) => o.type === 'create_materialized_view');
    expect(createOp).toBeDefined();
    expect(createOp!.sql).toMatch(/CREATE MATERIALIZED VIEW IF NOT EXISTS/);
  });

  it('does not error when creating a materialized view that already exists', async () => {
    // Create the mat view first
    await client.query(
      `CREATE MATERIALIZED VIEW ${TEST_SCHEMA}.items_count AS SELECT count(*) AS total FROM ${TEST_SCHEMA}.items`,
    );

    // Build a plan that wants to create the same mat view
    const mv: MaterializedViewSchema = {
      name: 'items_count',
      materialized: true,
      query: `SELECT count(*) AS total FROM ${TEST_SCHEMA}.items`,
    };
    const desired: DesiredState = { ...emptyDesired(), materializedViews: [mv] };
    const actual = emptyActual();

    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA });
    const createOp = plan.operations.find((o) => o.type === 'create_materialized_view');
    expect(createOp).toBeDefined();

    // Execute the SQL — should not throw 42P07 (duplicate_table)
    await expect(client.query(createOp!.sql)).resolves.not.toThrow();
  });
});
