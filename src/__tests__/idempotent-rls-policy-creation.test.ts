import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_idem_rls_${Date.now()}`;

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

describe('idempotent RLS policy creation', () => {
  it('generates DROP POLICY IF EXISTS before CREATE POLICY in the SQL', () => {
    const yaml = `
table: accounts
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: owner_id
    type: uuid
rls: true
policies:
  - name: owner_access
    for: SELECT
    to: public
    using: "owner_id = current_setting('app.user_id')::uuid"
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    const policyOp = plan.operations.find((op) => op.type === 'create_policy');
    expect(policyOp).toBeDefined();
    expect(policyOp!.sql).toContain('DROP POLICY IF EXISTS');
    expect(policyOp!.sql).toContain('CREATE POLICY');
  });

  it('policy SQL executes successfully when policy already exists', async () => {
    const yaml = `
table: test_rls_table
columns:
  - name: id
    type: serial
    primary_key: true
  - name: tenant_id
    type: integer
rls: true
policies:
  - name: tenant_isolation
    for: ALL
    to: public
    using: "true"
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    // Execute all operations to create the table, enable RLS, and create policy
    for (const op of plan.operations) {
      await client.query(op.sql);
    }

    // Build a new plan (same desired, empty actual) and re-execute the policy op.
    // This simulates re-running when the policy already exists.
    const plan2 = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });
    const policyOp = plan2.operations.find((op) => op.type === 'create_policy');
    expect(policyOp).toBeDefined();

    // This should NOT throw 42710 (duplicate_object)
    await expect(client.query(policyOp!.sql)).resolves.not.toThrow();
  });

  it('RESTRICTIVE policy also gets idempotency guard', () => {
    const yaml = `
table: documents
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: org_id
    type: uuid
rls: true
policies:
  - name: org_restrict
    for: DELETE
    to: public
    permissive: false
    using: "org_id = current_setting('app.org_id')::uuid"
    check: "org_id = current_setting('app.org_id')::uuid"
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);
    const plan = buildPlan(desired, emptyActual(), { pgSchema: TEST_SCHEMA });

    const policyOp = plan.operations.find((op) => op.type === 'create_policy');
    expect(policyOp).toBeDefined();
    expect(policyOp!.sql).toContain('DROP POLICY IF EXISTS');
    expect(policyOp!.sql).toContain('CREATE POLICY');
    expect(policyOp!.sql).toContain('RESTRICTIVE');
  });

  it('policy in diff path also gets idempotency guard', () => {
    const yaml = `
table: items
columns:
  - name: id
    type: serial
    primary_key: true
  - name: user_id
    type: integer
rls: true
policies:
  - name: user_items
    for: SELECT
    to: public
    using: "true"
`;
    const table = parseTable(yaml);
    const desired = emptyDesired();
    desired.tables.push(table);

    // Simulate an existing table with no policies
    const actual = emptyActual();
    actual.tables.set('items', {
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'user_id', type: 'integer', nullable: true },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
      checks: [],
      triggers: [],
      policies: [],
      grants: [],
      uniqueConstraints: [],
      rls: true,
      forceRls: false,
    });

    const plan = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA });
    const policyOp = plan.operations.find((op) => op.type === 'create_policy');
    expect(policyOp).toBeDefined();
    expect(policyOp!.sql).toContain('DROP POLICY IF EXISTS');
    expect(policyOp!.sql).toContain('CREATE POLICY');
  });
});
