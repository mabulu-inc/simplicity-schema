import { describe, it, expect, afterAll } from 'vitest';
import { useTestProject, writeSchema } from '../index.js';
import { closePool, getPool } from '../../core/db.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATABASE_URL = process.env.DATABASE_URL!;

afterAll(async () => {
  await closePool();
});

describe('useTestProject', () => {
  it('creates an isolated database and temp directory', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // Should use public schema in an isolated database
      expect(project.schema).toBe('public');

      // Should have a temp directory
      expect(fs.existsSync(project.dir)).toBe(true);

      // Should have a config pointing to the isolated database
      expect(project.config.connectionString).toBe(project.connectionString);
      expect(project.config.pgSchema).toBe('public');
      expect(project.config.baseDir).toBe(project.dir);

      // Should be able to query in the isolated database
      const pool = getPool(project.connectionString);
      const client = await pool.connect();
      try {
        await client.query('CREATE TABLE test_table (id serial PRIMARY KEY)');
        const result = await client.query('SELECT count(*) FROM test_table');
        expect(result.rows[0].count).toBe('0');
      } finally {
        client.release();
      }
    } finally {
      await project.cleanup();
    }
  });

  it('cleanup drops the database and removes the temp directory', async () => {
    const project = await useTestProject(DATABASE_URL);
    const dbName = new URL(project.connectionString).pathname.slice(1);
    const dir = project.dir;

    await project.cleanup();

    // Database should be dropped
    const pool = getPool(DATABASE_URL);
    const client = await pool.connect();
    try {
      const result = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
      expect(result.rows.length).toBe(0);
    } finally {
      client.release();
    }

    // Temp directory should be removed
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('provides a working migrate helper', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // Write a table schema
      writeSchema(project.dir, {
        'tables/users.yaml': `table: users
columns:
  - name: id
    type: serial
    primaryKey: true
  - name: email
    type: text
    nullable: false
`,
      });

      // Run migration
      const result = await project.migrate();
      expect(result.executed).toBeGreaterThan(0);

      // Verify the table was created
      const pool = getPool(project.connectionString);
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position`,
        );
        expect(res.rows.map((r: { column_name: string }) => r.column_name)).toEqual(['id', 'email']);
      } finally {
        client.release();
      }
    } finally {
      await project.cleanup();
    }
  });

  it('provides a working drift helper', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // Write a table schema
      writeSchema(project.dir, {
        'tables/items.yaml': `table: items
columns:
  - name: id
    type: serial
    primaryKey: true
  - name: name
    type: text
`,
      });

      // Before migration, drift should show missing table
      const driftBefore = await project.drift();
      const missingTable = driftBefore.items.find((i) => i.type === 'table' && i.status === 'missing_in_db');
      expect(missingTable).toBeDefined();

      // After migration, table should no longer be missing
      await project.migrate();
      const driftAfter = await project.drift();
      const stillMissing = driftAfter.items.find((i) => i.type === 'table' && i.status === 'missing_in_db');
      expect(stillMissing).toBeUndefined();
    } finally {
      await project.cleanup();
    }
  });
});

describe('writeSchema', () => {
  it('writes YAML files to the specified directory', () => {
    const tmpDir = fs.mkdtempSync('/tmp/simplicity-test-');
    try {
      writeSchema(tmpDir, {
        'tables/users.yaml': 'name: users\ncolumns: []',
        'enums/status.yaml': 'name: status\nvalues: [active, inactive]',
      });

      expect(fs.existsSync(path.join(tmpDir, 'tables', 'users.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'enums', 'status.yaml'))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'tables', 'users.yaml'), 'utf-8')).toBe('name: users\ncolumns: []');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates nested directories as needed', () => {
    const tmpDir = fs.mkdtempSync('/tmp/simplicity-test-');
    try {
      writeSchema(tmpDir, {
        'deeply/nested/dir/file.yaml': 'content: here',
      });

      expect(fs.readFileSync(path.join(tmpDir, 'deeply', 'nested', 'dir', 'file.yaml'), 'utf-8')).toBe('content: here');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
