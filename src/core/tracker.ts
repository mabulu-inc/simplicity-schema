/**
 * File tracker for schema-flow.
 *
 * Manages the _smplcty_schema_flow.history table that tracks which files have been
 * applied and their SHA-256 hashes. Files are re-run only when content changes.
 */

import type pg from 'pg';
import type { Phase } from './files.js';
import type { Logger } from './logger.js';

export interface HistoryEntry {
  filePath: string;
  fileHash: string;
  phase: Phase;
  appliedAt: Date;
}

/**
 * Migrate the legacy `_simplicity` schema to `_smplcty_schema_flow` if needed.
 * Also renames dual-write triggers/functions from `_simplicity_dw_` to `_smplcty_sf_dw_`.
 */
async function migrateLegacySchema(client: pg.PoolClient, logger?: Logger): Promise<void> {
  const { rows } = await client.query(`
    SELECT nspname FROM pg_namespace WHERE nspname IN ('_simplicity', '_smplcty_schema_flow')
  `);
  const schemas = new Set(rows.map((r) => r.nspname as string));
  const hasOld = schemas.has('_simplicity');
  const hasNew = schemas.has('_smplcty_schema_flow');

  if (hasOld && hasNew) {
    logger?.warn(
      'Both _simplicity and _smplcty_schema_flow schemas exist. Leaving _simplicity untouched — reconcile manually.',
    );
    return;
  }

  if (hasOld && !hasNew) {
    await client.query('ALTER SCHEMA _simplicity RENAME TO _smplcty_schema_flow');
    logger?.info('Migrated internal schema: _simplicity \u2192 _smplcty_schema_flow');
  }

  await renameLegacyDualWriteObjects(client, logger);
}

/**
 * Rename dual-write triggers and functions from `_simplicity_dw_` prefix to `_smplcty_sf_dw_`.
 */
async function renameLegacyDualWriteObjects(client: pg.PoolClient, logger?: Logger): Promise<void> {
  // Rename triggers
  const triggers = await client.query(`
    SELECT t.tgname, c.relname, n.nspname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE t.tgname LIKE '_simplicity_dw_%'
  `);
  for (const row of triggers.rows) {
    const oldName = row.tgname as string;
    const newName = oldName.replace('_simplicity_dw_', '_smplcty_sf_dw_');
    await client.query(`ALTER TRIGGER "${oldName}" ON "${row.nspname}"."${row.relname}" RENAME TO "${newName}"`);
    logger?.info(`Renamed trigger: ${oldName} \u2192 ${newName}`);
  }

  // Rename functions
  const functions = await client.query(`
    SELECT p.proname, n.nspname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname LIKE '_simplicity_dw_%'
  `);
  for (const row of functions.rows) {
    const oldName = row.proname as string;
    const newName = oldName.replace('_simplicity_dw_', '_smplcty_sf_dw_');
    await client.query(`ALTER FUNCTION "${row.nspname}"."${oldName}"(${row.args}) RENAME TO "${newName}"`);
    logger?.info(`Renamed function: ${oldName} \u2192 ${newName}`);
  }
}

/**
 * Ensure the _smplcty_schema_flow schema and history table exist.
 * On first run, migrates any legacy `_simplicity` schema automatically.
 */
export async function ensureHistoryTable(client: pg.PoolClient, logger?: Logger): Promise<void> {
  await migrateLegacySchema(client, logger);
  await client.query('CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow');
  await client.query(`
    CREATE TABLE IF NOT EXISTS _smplcty_schema_flow.history (
      file_path  text PRIMARY KEY,
      file_hash  text NOT NULL,
      phase      text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Get all entries from the history table.
 */
export async function getHistory(client: pg.PoolClient): Promise<HistoryEntry[]> {
  const result = await client.query(
    'SELECT file_path, file_hash, phase, applied_at FROM _smplcty_schema_flow.history ORDER BY file_path',
  );
  return result.rows.map((row) => ({
    filePath: row.file_path,
    fileHash: row.file_hash,
    phase: row.phase as Phase,
    appliedAt: row.applied_at,
  }));
}

/**
 * Get the stored hash for a specific file, or null if not tracked.
 */
export async function getFileHash(client: pg.PoolClient, filePath: string): Promise<string | null> {
  const result = await client.query('SELECT file_hash FROM _smplcty_schema_flow.history WHERE file_path = $1', [
    filePath,
  ]);
  return result.rows.length > 0 ? result.rows[0].file_hash : null;
}

/**
 * Record a file as applied (upsert).
 */
export async function recordFile(
  client: pg.PoolClient,
  filePath: string,
  fileHash: string,
  phase: Phase,
): Promise<void> {
  await client.query(
    `INSERT INTO _smplcty_schema_flow.history (file_path, file_hash, phase, applied_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (file_path) DO UPDATE
       SET file_hash = EXCLUDED.file_hash,
           phase = EXCLUDED.phase,
           applied_at = EXCLUDED.applied_at`,
    [filePath, fileHash, phase],
  );
}

/**
 * Check if a file needs to be re-run (new file or hash changed).
 */
export async function fileNeedsApply(client: pg.PoolClient, filePath: string, currentHash: string): Promise<boolean> {
  const storedHash = await getFileHash(client, filePath);
  return storedHash !== currentHash;
}

/**
 * Remove a file's history entry (e.g., when file is deleted).
 */
export async function removeFileHistory(client: pg.PoolClient, filePath: string): Promise<boolean> {
  const result = await client.query('DELETE FROM _smplcty_schema_flow.history WHERE file_path = $1', [filePath]);
  return (result.rowCount ?? 0) > 0;
}
