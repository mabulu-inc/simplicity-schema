import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { discoverSchemaFiles, hashFile } from '../files.js';

describe('files', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'simplicity-files-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('hashFile', () => {
    it('returns SHA-256 hex digest of file contents', async () => {
      const filePath = path.join(tmpDir, 'test.yaml');
      const content = 'table: users\n';
      await writeFile(filePath, content);

      const hash = await hashFile(filePath);
      const expected = createHash('sha256').update(content).digest('hex');
      expect(hash).toBe(expected);
    });

    it('returns different hashes for different content', async () => {
      const file1 = path.join(tmpDir, 'a.yaml');
      const file2 = path.join(tmpDir, 'b.yaml');
      await writeFile(file1, 'content-a');
      await writeFile(file2, 'content-b');

      const hash1 = await hashFile(file1);
      const hash2 = await hashFile(file2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('discoverSchemaFiles', () => {
    it('returns empty result for empty directory', async () => {
      const result = await discoverSchemaFiles(tmpDir);
      expect(result.pre).toEqual([]);
      expect(result.schema).toEqual([]);
      expect(result.post).toEqual([]);
    });

    it('discovers pre-scripts as phase "pre"', async () => {
      await mkdir(path.join(tmpDir, 'pre'), { recursive: true });
      await writeFile(path.join(tmpDir, 'pre', '001_setup.sql'), 'SELECT 1;');
      await writeFile(path.join(tmpDir, 'pre', '002_seed.sql'), 'SELECT 2;');

      const result = await discoverSchemaFiles(tmpDir);
      expect(result.pre).toHaveLength(2);
      expect(result.pre[0].relativePath).toBe('pre/001_setup.sql');
      expect(result.pre[1].relativePath).toBe('pre/002_seed.sql');
      expect(result.pre[0].phase).toBe('pre');
      expect(result.pre[1].phase).toBe('pre');
    });

    it('discovers post-scripts as phase "post"', async () => {
      await mkdir(path.join(tmpDir, 'post'), { recursive: true });
      await writeFile(path.join(tmpDir, 'post', 'refresh.sql'), 'REFRESH;');

      const result = await discoverSchemaFiles(tmpDir);
      expect(result.post).toHaveLength(1);
      expect(result.post[0].relativePath).toBe('post/refresh.sql');
      expect(result.post[0].phase).toBe('post');
    });

    it('discovers table YAML files as phase "schema"', async () => {
      await mkdir(path.join(tmpDir, 'tables'), { recursive: true });
      await writeFile(path.join(tmpDir, 'tables', 'users.yaml'), 'table: users');
      await writeFile(path.join(tmpDir, 'tables', 'orders.yaml'), 'table: orders');

      const result = await discoverSchemaFiles(tmpDir);
      expect(result.schema).toHaveLength(2);
      const paths = result.schema.map((f) => f.relativePath);
      expect(paths).toContain('tables/orders.yaml');
      expect(paths).toContain('tables/users.yaml');
      expect(result.schema.every((f) => f.phase === 'schema')).toBe(true);
    });

    it('discovers enum, function, view, role, and mixin files', async () => {
      const dirs = ['enums', 'functions', 'views', 'roles', 'mixins'];
      for (const dir of dirs) {
        await mkdir(path.join(tmpDir, dir), { recursive: true });
        await writeFile(path.join(tmpDir, dir, 'test.yaml'), `kind: ${dir}`);
      }

      const result = await discoverSchemaFiles(tmpDir);
      expect(result.schema).toHaveLength(5);
      const paths = result.schema.map((f) => f.relativePath);
      for (const dir of dirs) {
        expect(paths).toContain(`${dir}/test.yaml`);
      }
    });

    it('discovers extensions.yaml at root level', async () => {
      await writeFile(path.join(tmpDir, 'extensions.yaml'), 'extensions: [pgcrypto]');

      const result = await discoverSchemaFiles(tmpDir);
      expect(result.schema).toHaveLength(1);
      expect(result.schema[0].relativePath).toBe('extensions.yaml');
      expect(result.schema[0].phase).toBe('schema');
    });

    it('sorts files alphabetically within each phase', async () => {
      await mkdir(path.join(tmpDir, 'pre'), { recursive: true });
      await writeFile(path.join(tmpDir, 'pre', 'c.sql'), 'c');
      await writeFile(path.join(tmpDir, 'pre', 'a.sql'), 'a');
      await writeFile(path.join(tmpDir, 'pre', 'b.sql'), 'b');

      const result = await discoverSchemaFiles(tmpDir);
      const paths = result.pre.map((f) => f.relativePath);
      expect(paths).toEqual(['pre/a.sql', 'pre/b.sql', 'pre/c.sql']);
    });

    it('includes correct SHA-256 hashes', async () => {
      await mkdir(path.join(tmpDir, 'tables'), { recursive: true });
      const content = 'table: users\ncolumns: []\n';
      await writeFile(path.join(tmpDir, 'tables', 'users.yaml'), content);

      const result = await discoverSchemaFiles(tmpDir);
      const expected = createHash('sha256').update(content).digest('hex');
      expect(result.schema[0].hash).toBe(expected);
    });

    it('includes absolute paths', async () => {
      await mkdir(path.join(tmpDir, 'tables'), { recursive: true });
      await writeFile(path.join(tmpDir, 'tables', 'users.yaml'), 'table: users');

      const result = await discoverSchemaFiles(tmpDir);
      expect(path.isAbsolute(result.schema[0].absolutePath)).toBe(true);
      expect(result.schema[0].absolutePath).toContain('users.yaml');
    });

    it('discovers files across all phases simultaneously', async () => {
      await mkdir(path.join(tmpDir, 'pre'), { recursive: true });
      await mkdir(path.join(tmpDir, 'tables'), { recursive: true });
      await mkdir(path.join(tmpDir, 'post'), { recursive: true });
      await writeFile(path.join(tmpDir, 'pre', 'setup.sql'), 'pre');
      await writeFile(path.join(tmpDir, 'tables', 'users.yaml'), 'schema');
      await writeFile(path.join(tmpDir, 'post', 'cleanup.sql'), 'post');

      const result = await discoverSchemaFiles(tmpDir);
      expect(result.pre).toHaveLength(1);
      expect(result.schema).toHaveLength(1);
      expect(result.post).toHaveLength(1);
    });

    it('ignores non-matching files', async () => {
      await mkdir(path.join(tmpDir, 'tables'), { recursive: true });
      await writeFile(path.join(tmpDir, 'tables', 'users.yaml'), 'table: users');
      await writeFile(path.join(tmpDir, 'tables', 'notes.txt'), 'not a schema file');
      await writeFile(path.join(tmpDir, 'random.json'), '{}');

      const result = await discoverSchemaFiles(tmpDir);
      expect(result.schema).toHaveLength(1);
      expect(result.schema[0].relativePath).toBe('tables/users.yaml');
    });
  });
});
