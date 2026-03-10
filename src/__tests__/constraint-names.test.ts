import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { parseTable } from '../schema/parser.js';
import { buildPlan, type DesiredState, type ActualState } from '../planner/index.js';
import { introspectTable } from '../introspect/index.js';
import { detectDrift } from '../drift/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_constraint_names_${Date.now()}`;

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

async function exec(sql: string) {
  await client.query(`SET search_path TO ${TEST_SCHEMA}`);
  await client.query(sql);
  await client.query(`SET search_path TO public`);
}

// ─── Parser ──────────────────────────────────────────────────────

describe('parser: custom constraint names', () => {
  it('parses primary_key_name on table', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
primary_key: [id]
primary_key_name: pk_users
`;
    const result = parseTable(yaml);
    expect(result.primary_key_name).toBe('pk_users');
  });

  it('parses unique_name on column', () => {
    const yaml = `
table: users
columns:
  - name: email
    type: text
    unique: true
    unique_name: uq_users_email
`;
    const result = parseTable(yaml);
    expect(result.columns[0].unique_name).toBe('uq_users_email');
  });

  it('parses name on foreign key reference', () => {
    const yaml = `
table: users
columns:
  - name: role_id
    type: uuid
    references:
      table: roles
      column: id
      name: fk_users_role
`;
    const result = parseTable(yaml);
    expect(result.columns[0].references!.name).toBe('fk_users_role');
  });

  it('omits custom names when not provided', () => {
    const yaml = `
table: users
columns:
  - name: id
    type: uuid
    unique: true
    references:
      table: roles
      column: id
primary_key: [id]
`;
    const result = parseTable(yaml);
    expect(result.primary_key_name).toBeUndefined();
    expect(result.columns[0].unique_name).toBeUndefined();
    expect(result.columns[0].references!.name).toBeUndefined();
  });
});

// ─── Planner ─────────────────────────────────────────────────────

describe('planner: custom constraint names', () => {
  it('generates CREATE TABLE with custom PK constraint name', () => {
    const table = parseTable(`
table: items
columns:
  - name: id
    type: uuid
primary_key: [id]
primary_key_name: pk_items
`);
    const desired: DesiredState = {
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map(),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const ops = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA }).operations;
    const createOp = ops.find((o) => o.type === 'create_table');
    expect(createOp).toBeDefined();
    expect(createOp!.sql).toContain('CONSTRAINT "pk_items" PRIMARY KEY');
  });

  it('generates CREATE TABLE with custom column unique constraint name', () => {
    const table = parseTable(`
table: items
columns:
  - name: id
    type: uuid
  - name: email
    type: text
    unique: true
    unique_name: uq_items_email
`);
    const desired: DesiredState = {
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map(),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const ops = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA }).operations;
    const createOp = ops.find((o) => o.type === 'create_table');
    expect(createOp).toBeDefined();
    expect(createOp!.sql).toContain('CONSTRAINT "uq_items_email" UNIQUE');
  });

  it('generates FK with custom constraint name', () => {
    const table = parseTable(`
table: items
columns:
  - name: id
    type: uuid
  - name: user_id
    type: uuid
    references:
      table: users
      column: id
      name: fk_items_user
`);
    const desired: DesiredState = {
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map(),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const ops = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA }).operations;
    const fkOp = ops.find((o) => o.type === 'add_foreign_key_not_valid');
    expect(fkOp).toBeDefined();
    expect(fkOp!.sql).toContain('CONSTRAINT "fk_items_user"');
    const validateOp = ops.find((o) => o.type === 'validate_constraint');
    expect(validateOp).toBeDefined();
    expect(validateOp!.sql).toContain('VALIDATE CONSTRAINT "fk_items_user"');
  });

  it('uses default naming when custom names not specified', () => {
    const table = parseTable(`
table: items
columns:
  - name: id
    type: uuid
    unique: true
  - name: user_id
    type: uuid
    references:
      table: users
      column: id
primary_key: [id]
`);
    const desired: DesiredState = {
      tables: [table],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map(),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const ops = buildPlan(desired, actual, { pgSchema: TEST_SCHEMA }).operations;
    const createOp = ops.find((o) => o.type === 'create_table');
    // Default PK — no CONSTRAINT clause, just PRIMARY KEY (...)
    expect(createOp!.sql).toContain('PRIMARY KEY');
    // Default column unique — just UNIQUE keyword
    expect(createOp!.sql).toContain('UNIQUE');
    // Default FK naming
    const fkOp = ops.find((o) => o.type === 'add_foreign_key_not_valid');
    expect(fkOp!.sql).toContain('CONSTRAINT "fk_items_user_id_users"');
  });
});

// ─── Introspection ───────────────────────────────────────────────

describe('introspection: custom constraint names', () => {
  beforeAll(async () => {
    await exec(`CREATE TABLE roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text
    )`);
    await exec(`CREATE TABLE accounts (
      id uuid NOT NULL,
      email text,
      role_id uuid,
      CONSTRAINT pk_accounts PRIMARY KEY (id),
      CONSTRAINT uq_accounts_email UNIQUE (email),
      CONSTRAINT fk_accounts_role FOREIGN KEY (role_id) REFERENCES roles(id)
    )`);
  });

  it('introspects custom PK constraint name', async () => {
    const result = await introspectTable(client, 'accounts', TEST_SCHEMA);
    expect(result.primary_key_name).toBe('pk_accounts');
  });

  it('introspects custom FK constraint name', async () => {
    const result = await introspectTable(client, 'accounts', TEST_SCHEMA);
    const roleCol = result.columns.find((c) => c.name === 'role_id');
    expect(roleCol?.references?.name).toBe('fk_accounts_role');
  });

  it('does not set primary_key_name for default-named PK', async () => {
    const result = await introspectTable(client, 'roles', TEST_SCHEMA);
    // Default PK name is "roles_pkey" — should not be reported as custom
    expect(result.primary_key_name).toBeUndefined();
  });

  it('does not set FK name for default-named FK', async () => {
    await exec(`CREATE TABLE orders (
      id uuid PRIMARY KEY,
      role_id uuid REFERENCES roles(id)
    )`);
    const result = await introspectTable(client, 'orders', TEST_SCHEMA);
    const roleCol = result.columns.find((c) => c.name === 'role_id');
    // Default FK name is "orders_role_id_fkey" — should not be reported as custom
    expect(roleCol?.references?.name).toBeUndefined();
  });

  it('introspects custom unique constraint name on column', async () => {
    const result = await introspectTable(client, 'accounts', TEST_SCHEMA);
    const emailCol = result.columns.find((c) => c.name === 'email');
    expect(emailCol?.unique).toBe(true);
    expect(emailCol?.unique_name).toBe('uq_accounts_email');
  });

  it('does not set unique_name for default-named unique constraint', async () => {
    await exec(`CREATE TABLE products (
      id uuid PRIMARY KEY,
      sku text UNIQUE
    )`);
    const result = await introspectTable(client, 'products', TEST_SCHEMA);
    const skuCol = result.columns.find((c) => c.name === 'sku');
    expect(skuCol?.unique).toBe(true);
    // Default unique name is "products_sku_key" — should not be reported as custom
    expect(skuCol?.unique_name).toBeUndefined();
  });
});

// ─── Drift ───────────────────────────────────────────────────────

describe('drift: custom constraint names', () => {
  it('detects drift when PK constraint name differs', () => {
    const desired: DesiredState = {
      tables: [
        {
          table: 'items',
          columns: [{ name: 'id', type: 'uuid' }],
          primary_key: ['id'],
          primary_key_name: 'pk_items',
        },
      ],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map([
        [
          'items',
          {
            table: 'items',
            columns: [{ name: 'id', type: 'uuid' }],
            primary_key: ['id'],
            primary_key_name: 'items_pkey',
          },
        ],
      ]),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const report = detectDrift(desired, actual);
    const pkDrift = report.items.find((i) => i.object.includes('primary_key'));
    expect(pkDrift).toBeDefined();
    expect(pkDrift!.status).toBe('different');
    expect(pkDrift!.detail).toContain('pk_items');
  });

  it('reports no drift when PK name matches', () => {
    const desired: DesiredState = {
      tables: [
        {
          table: 'items',
          columns: [{ name: 'id', type: 'uuid' }],
          primary_key: ['id'],
          primary_key_name: 'pk_items',
        },
      ],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map([
        [
          'items',
          {
            table: 'items',
            columns: [{ name: 'id', type: 'uuid' }],
            primary_key: ['id'],
            primary_key_name: 'pk_items',
          },
        ],
      ]),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const report = detectDrift(desired, actual);
    const pkDrift = report.items.find((i) => i.object.includes('primary_key'));
    expect(pkDrift).toBeUndefined();
  });

  it('detects drift when unique_name differs', () => {
    const desired: DesiredState = {
      tables: [
        {
          table: 'items',
          columns: [
            { name: 'id', type: 'uuid' },
            { name: 'email', type: 'text', unique: true, unique_name: 'uq_items_email' },
          ],
        },
      ],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map([
        [
          'items',
          {
            table: 'items',
            columns: [
              { name: 'id', type: 'uuid' },
              { name: 'email', type: 'text', unique: true, unique_name: 'items_email_key' },
            ],
          },
        ],
      ]),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const report = detectDrift(desired, actual);
    const drift = report.items.find((i) => i.type === 'constraint' && i.detail?.includes('unique_name'));
    expect(drift).toBeDefined();
    expect(drift!.status).toBe('different');
  });

  it('reports no drift when unique_name matches', () => {
    const desired: DesiredState = {
      tables: [
        {
          table: 'items',
          columns: [{ name: 'email', type: 'text', unique: true, unique_name: 'uq_items_email' }],
        },
      ],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map([
        [
          'items',
          {
            table: 'items',
            columns: [{ name: 'email', type: 'text', unique: true, unique_name: 'uq_items_email' }],
          },
        ],
      ]),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const report = detectDrift(desired, actual);
    const drift = report.items.find((i) => i.type === 'constraint' && i.detail?.includes('unique_name'));
    expect(drift).toBeUndefined();
  });

  it('detects drift when FK constraint name differs', () => {
    const desired: DesiredState = {
      tables: [
        {
          table: 'items',
          columns: [
            { name: 'id', type: 'uuid' },
            {
              name: 'user_id',
              type: 'uuid',
              references: { table: 'users', column: 'id', name: 'fk_items_user' },
            },
          ],
        },
      ],
      enums: [],
      functions: [],
      views: [],
      materializedViews: [],
      roles: [],
      extensions: null,
    };
    const actual: ActualState = {
      tables: new Map([
        [
          'items',
          {
            table: 'items',
            columns: [
              { name: 'id', type: 'uuid' },
              {
                name: 'user_id',
                type: 'uuid',
                references: { table: 'users', column: 'id', name: 'items_user_id_fkey' },
              },
            ],
          },
        ],
      ]),
      enums: new Map(),
      functions: new Map(),
      views: new Map(),
      materializedViews: new Map(),
      roles: new Map(),
      extensions: [],
    };
    const report = detectDrift(desired, actual);
    const fkDrift = report.items.find(
      (i) => i.type === 'constraint' && i.object.includes('user_id') && i.detail?.includes('FK name'),
    );
    expect(fkDrift).toBeDefined();
    expect(fkDrift!.status).toBe('different');
  });
});
