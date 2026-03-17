import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_idempotent_table_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
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

describe('idempotent table creation', () => {
  it('generates CREATE TABLE IF NOT EXISTS in the SQL', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: name
    type: text
    nullable: false
`;
    const table = parseTable(yaml);
    const desired: DesiredState = { ...emptyDesired(), tables: [table] };
    const actual = emptyActual();
    const plan = buildPlan(desired, actual);
    const createOp = plan.operations.find((o) => o.type === 'create_table');
    expect(createOp).toBeDefined();
    expect(createOp!.sql).toMatch(/CREATE TABLE IF NOT EXISTS/);
  });

  it('does not error when creating a table that already exists', async () => {
    // Create the table first
    await client.query(`CREATE TABLE ${TEST_SCHEMA}.widgets (id uuid PRIMARY KEY, label text NOT NULL)`);

    // Build a plan that wants to create the same table
    const yaml = `
table: widgets
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: label
    type: text
    nullable: false
`;
    const table = parseTable(yaml);
    const desired: DesiredState = { ...emptyDesired(), tables: [table] };
    const actual = emptyActual();

    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA });
    const createOp = plan.operations.find((o) => o.type === 'create_table');
    expect(createOp).toBeDefined();

    // Execute the SQL — should not throw 42P07 (duplicate_table)
    await expect(client.query(createOp!.sql)).resolves.not.toThrow();
  });
});
