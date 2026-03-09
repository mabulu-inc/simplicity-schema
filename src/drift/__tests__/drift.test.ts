import { describe, it, expect } from 'vitest';
import { detectDrift } from '../index.js';
import type { DesiredState, ActualState } from '../../planner/index.js';
import type { DriftReport, DriftItem } from '../index.js';

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

describe('detectDrift', () => {
  it('returns empty report when desired and actual are both empty', () => {
    const report = detectDrift(emptyDesired(), emptyActual());
    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  // ─── Tables ────────────────────────────────────────────────────

  it('reports table missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'table',
        object: 'users',
        status: 'missing_in_db',
      }),
    );
    expect(report.summary.total).toBeGreaterThan(0);
  });

  it('reports table missing in YAML', () => {
    const actual = emptyActual();
    actual.tables.set('legacy', {
      table: 'legacy',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(emptyDesired(), actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'table',
        object: 'legacy',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Columns ───────────────────────────────────────────────────

  it('reports column missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text', nullable: false },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.email',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports column missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'old_col', type: 'text' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.old_col',
        status: 'missing_in_yaml',
      }),
    );
  });

  it('reports column type difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'age', type: 'bigint' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'age', type: 'integer' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.age',
        status: 'different',
        expected: expect.stringContaining('bigint'),
        actual: expect.stringContaining('integer'),
      }),
    );
  });

  it('reports column nullability difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text', nullable: false },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'name', type: 'text' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.name',
        status: 'different',
        detail: expect.stringContaining('nullable'),
      }),
    );
  });

  it('reports column default difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'active', type: 'boolean', default: 'true' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'active', type: 'boolean' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.active',
        status: 'different',
        detail: expect.stringContaining('default'),
      }),
    );
  });

  // ─── Indexes ───────────────────────────────────────────────────

  it('reports index missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }, { name: 'email', type: 'text' }],
        indexes: [{ name: 'idx_users_email', columns: ['email'] }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }, { name: 'email', type: 'text' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_users_email',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports index missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      indexes: [{ name: 'idx_old', columns: ['id'] }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_old',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Enums ─────────────────────────────────────────────────────

  it('reports enum missing in DB', () => {
    const desired = emptyDesired();
    desired.enums = [{ name: 'status', values: ['active', 'inactive'] }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'enum',
        object: 'status',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports enum missing in YAML', () => {
    const actual = emptyActual();
    actual.enums.set('old_status', { name: 'old_status', values: ['a', 'b'] });
    const report = detectDrift(emptyDesired(), actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'enum',
        object: 'old_status',
        status: 'missing_in_yaml',
      }),
    );
  });

  it('reports enum value differences', () => {
    const desired = emptyDesired();
    desired.enums = [{ name: 'status', values: ['active', 'inactive', 'pending'] }];
    const actual = emptyActual();
    actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'enum',
        object: 'status',
        status: 'different',
      }),
    );
  });

  // ─── Functions ─────────────────────────────────────────────────

  it('reports function missing in DB', () => {
    const desired = emptyDesired();
    desired.functions = [
      { name: 'my_func', returns: 'trigger', body: 'BEGIN RETURN NEW; END;', language: 'plpgsql' },
    ];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'my_func',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports function missing in YAML', () => {
    const actual = emptyActual();
    actual.functions.set('old_func', { name: 'old_func', returns: 'void', body: '', language: 'sql' });
    const report = detectDrift(emptyDesired(), actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'old_func',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Views ─────────────────────────────────────────────────────

  it('reports view missing in DB', () => {
    const desired = emptyDesired();
    desired.views = [{ name: 'active_users', query: 'SELECT * FROM users WHERE active = true' }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'view',
        object: 'active_users',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports view query difference', () => {
    const desired = emptyDesired();
    desired.views = [{ name: 'active_users', query: 'SELECT * FROM users WHERE active = true' }];
    const actual = emptyActual();
    actual.views.set('active_users', { name: 'active_users', query: 'SELECT * FROM users WHERE active = false' });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'view',
        object: 'active_users',
        status: 'different',
      }),
    );
  });

  // ─── Materialized Views ────────────────────────────────────────

  it('reports materialized view missing in DB', () => {
    const desired = emptyDesired();
    desired.materializedViews = [{ name: 'mv_stats', query: 'SELECT count(*) FROM users' }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'materialized_view',
        object: 'mv_stats',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports materialized view query difference', () => {
    const desired = emptyDesired();
    desired.materializedViews = [{ name: 'mv_stats', query: 'SELECT count(*) FROM users' }];
    const actual = emptyActual();
    actual.materializedViews.set('mv_stats', { name: 'mv_stats', query: 'SELECT sum(1) FROM users' });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'materialized_view',
        object: 'mv_stats',
        status: 'different',
      }),
    );
  });

  // ─── Roles ─────────────────────────────────────────────────────

  it('reports role missing in DB', () => {
    const desired = emptyDesired();
    desired.roles = [{ role: 'app_user', login: true }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'role',
        object: 'app_user',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports role attribute difference', () => {
    const desired = emptyDesired();
    desired.roles = [{ role: 'app_user', login: true }];
    const actual = emptyActual();
    actual.roles.set('app_user', { role: 'app_user', login: false });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'role',
        object: 'app_user',
        status: 'different',
      }),
    );
  });

  // ─── Extensions ────────────────────────────────────────────────

  it('reports extension missing in DB', () => {
    const desired = emptyDesired();
    desired.extensions = { extensions: ['uuid-ossp', 'pgcrypto'] };
    const actual = emptyActual();
    actual.extensions = ['uuid-ossp'];
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'extension' as any,
        object: 'pgcrypto',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports extension missing in YAML', () => {
    const desired = emptyDesired();
    desired.extensions = { extensions: ['uuid-ossp'] };
    const actual = emptyActual();
    actual.extensions = ['uuid-ossp', 'pgcrypto'];
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'extension' as any,
        object: 'pgcrypto',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Triggers ──────────────────────────────────────────────────

  it('reports trigger missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        triggers: [{ name: 'trg_updated', timing: 'BEFORE', events: ['UPDATE'], function: 'set_updated_at' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'trigger',
        object: 'users.trg_updated',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports trigger missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      triggers: [{ name: 'trg_old', timing: 'BEFORE', events: ['UPDATE'], function: 'old_func' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'trigger',
        object: 'users.trg_old',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Policies ──────────────────────────────────────────────────

  it('reports policy missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        policies: [{ name: 'user_access', to: 'app_user', using: 'id = current_user_id()' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'policy',
        object: 'users.user_access',
        status: 'missing_in_db',
      }),
    );
  });

  // ─── Checks ────────────────────────────────────────────────────

  it('reports check constraint missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }, { name: 'age', type: 'integer' }],
        checks: [{ name: 'chk_age_positive', expression: 'age > 0' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }, { name: 'age', type: 'integer' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: 'users.chk_age_positive',
        status: 'missing_in_db',
      }),
    );
  });

  // ─── Comments ──────────────────────────────────────────────────

  it('reports table comment difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        comment: 'User accounts',
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      comment: 'Old comment',
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'comment',
        object: 'users',
        status: 'different',
      }),
    );
  });

  // ─── Summary ───────────────────────────────────────────────────

  it('populates summary with totals and byType counts', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      },
    ];
    desired.enums = [{ name: 'status', values: ['a'] }];
    const report = detectDrift(desired, emptyActual());
    expect(report.summary.total).toBe(report.items.length);
    expect(report.summary.byType).toBeDefined();
    // Should have entries for table and enum at minimum
    expect(report.summary.byType['table']).toBeGreaterThanOrEqual(1);
    expect(report.summary.byType['enum']).toBeGreaterThanOrEqual(1);
  });

  // ─── No drift when matching ────────────────────────────────────

  it('returns empty report when desired and actual match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      },
    ];
    desired.enums = [{ name: 'status', values: ['active', 'inactive'] }];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text' },
      ],
    });
    actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
    const report = detectDrift(desired, actual);
    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  // ─── Type alias normalization ──────────────────────────────────

  it('does not report drift for equivalent type aliases (int vs integer)', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'int', primary_key: true },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
      ],
    });
    const report = detectDrift(desired, actual);
    const colDrifts = report.items.filter((i) => i.type === 'column');
    expect(colDrifts).toEqual([]);
  });
});
