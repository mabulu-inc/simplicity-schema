import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { introspectTable } from '../introspect/index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_trig_when_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  await client.query(`SET search_path TO ${TEST_SCHEMA}`);

  // Create a trigger function
  await client.query(`
    CREATE FUNCTION ${TEST_SCHEMA}.audit_fn() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$
  `);

  // Create a table with triggers having various WHEN clauses
  await client.query(`
    CREATE TABLE ${TEST_SCHEMA}.items (
      id serial PRIMARY KEY,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active'
    )
  `);

  // Trigger with WHEN referencing both OLD and NEW (the problematic case)
  await client.query(`
    CREATE TRIGGER trg_old_new
      BEFORE UPDATE ON ${TEST_SCHEMA}.items
      FOR EACH ROW
      WHEN (OLD.* IS DISTINCT FROM NEW.*)
      EXECUTE FUNCTION ${TEST_SCHEMA}.audit_fn()
  `);

  // Trigger with WHEN referencing only NEW (should work with pg_get_expr too)
  await client.query(`
    CREATE TRIGGER trg_new_only
      BEFORE INSERT ON ${TEST_SCHEMA}.items
      FOR EACH ROW
      WHEN (NEW.status = 'active')
      EXECUTE FUNCTION ${TEST_SCHEMA}.audit_fn()
  `);

  // Trigger with WHEN referencing OLD and NEW columns individually
  await client.query(`
    CREATE TRIGGER trg_old_new_cols
      BEFORE UPDATE ON ${TEST_SCHEMA}.items
      FOR EACH ROW
      WHEN (OLD.name IS DISTINCT FROM NEW.name)
      EXECUTE FUNCTION ${TEST_SCHEMA}.audit_fn()
  `);

  // Trigger with no WHEN clause
  await client.query(`
    CREATE TRIGGER trg_no_when
      AFTER INSERT ON ${TEST_SCHEMA}.items
      FOR EACH ROW
      EXECUTE FUNCTION ${TEST_SCHEMA}.audit_fn()
  `);

  await client.query(`SET search_path TO public`);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`);
  client.release();
  await pool.end();
});

describe('trigger WHEN clause introspection', () => {
  it('introspects WHEN clause with OLD.* IS DISTINCT FROM NEW.*', async () => {
    const table = await introspectTable(client, 'items', TEST_SCHEMA);
    const trigger = table.triggers?.find((t) => t.name === 'trg_old_new');
    expect(trigger).toBeDefined();
    expect(trigger!.when).toBeDefined();
    // The exact form may vary (PostgreSQL may normalize), but it must contain OLD and NEW
    expect(trigger!.when).toMatch(/old/i);
    expect(trigger!.when).toMatch(/new/i);
    expect(trigger!.when).toMatch(/is distinct from/i);
  });

  it('introspects WHEN clause with NEW only', async () => {
    const table = await introspectTable(client, 'items', TEST_SCHEMA);
    const trigger = table.triggers?.find((t) => t.name === 'trg_new_only');
    expect(trigger).toBeDefined();
    expect(trigger!.when).toBeDefined();
    expect(trigger!.when).toMatch(/new\.status/i);
  });

  it('introspects WHEN clause with OLD.col IS DISTINCT FROM NEW.col', async () => {
    const table = await introspectTable(client, 'items', TEST_SCHEMA);
    const trigger = table.triggers?.find((t) => t.name === 'trg_old_new_cols');
    expect(trigger).toBeDefined();
    expect(trigger!.when).toBeDefined();
    expect(trigger!.when).toMatch(/old\.name/i);
    expect(trigger!.when).toMatch(/new\.name/i);
  });

  it('trigger without WHEN clause has no when property', async () => {
    const table = await introspectTable(client, 'items', TEST_SCHEMA);
    const trigger = table.triggers?.find((t) => t.name === 'trg_no_when');
    expect(trigger).toBeDefined();
    expect(trigger!.when).toBeUndefined();
  });
});
