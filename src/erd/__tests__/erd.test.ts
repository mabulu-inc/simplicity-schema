import { describe, it, expect } from 'vitest';
import { generateErd } from '../index.js';
import type { TableSchema } from '../../schema/types.js';

describe('ERD generation', () => {
  it('generates empty diagram for no tables', () => {
    const result = generateErd([]);
    expect(result).toBe('erDiagram\n');
  });

  it('generates a single table with columns', () => {
    const tables: TableSchema[] = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'name', type: 'text' },
          { name: 'age', type: 'integer', nullable: true },
        ],
      },
    ];
    const result = generateErd(tables);
    expect(result).toContain('erDiagram');
    expect(result).toContain('users {');
    expect(result).toContain('uuid id PK');
    expect(result).toContain('text name');
    expect(result).toContain('integer age');
    expect(result).toContain('}');
  });

  it('marks primary key columns with PK', () => {
    const tables: TableSchema[] = [
      {
        table: 'items',
        columns: [
          { name: 'id', type: 'bigint', primary_key: true },
          { name: 'value', type: 'text' },
        ],
      },
    ];
    const result = generateErd(tables);
    expect(result).toContain('bigint id PK');
    expect(result).not.toContain('text value PK');
  });

  it('marks foreign key columns with FK', () => {
    const tables: TableSchema[] = [
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          {
            name: 'user_id',
            type: 'uuid',
            references: { table: 'users', column: 'id' },
          },
        ],
      },
    ];
    const result = generateErd(tables);
    expect(result).toContain('uuid user_id FK');
  });

  it('generates foreign key relationships as edges', () => {
    const tables: TableSchema[] = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
      },
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          {
            name: 'user_id',
            type: 'uuid',
            references: { table: 'users', column: 'id' },
          },
        ],
      },
    ];
    const result = generateErd(tables);
    // Mermaid ER relationship syntax
    expect(result).toContain('users ||--o{ orders : "user_id"');
  });

  it('handles nullable FK as zero-or-more relationship', () => {
    const tables: TableSchema[] = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
      },
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          {
            name: 'author_id',
            type: 'uuid',
            nullable: true,
            references: { table: 'users', column: 'id' },
          },
        ],
      },
    ];
    const result = generateErd(tables);
    // nullable FK = zero or one on the parent side
    expect(result).toContain('users |o--o{ posts : "author_id"');
  });

  it('handles multiple foreign keys from one table', () => {
    const tables: TableSchema[] = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
      },
      {
        table: 'messages',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          {
            name: 'sender_id',
            type: 'uuid',
            references: { table: 'users', column: 'id' },
          },
          {
            name: 'receiver_id',
            type: 'uuid',
            references: { table: 'users', column: 'id' },
          },
        ],
      },
    ];
    const result = generateErd(tables);
    expect(result).toContain('users ||--o{ messages : "sender_id"');
    expect(result).toContain('users ||--o{ messages : "receiver_id"');
  });

  it('handles unique FK columns (one-to-one relationship)', () => {
    const tables: TableSchema[] = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
      },
      {
        table: 'profiles',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          {
            name: 'user_id',
            type: 'uuid',
            unique: true,
            references: { table: 'users', column: 'id' },
          },
        ],
      },
    ];
    const result = generateErd(tables);
    expect(result).toContain('users ||--|| profiles : "user_id"');
  });

  it('handles table with composite primary key', () => {
    const tables: TableSchema[] = [
      {
        table: 'order_items',
        primary_key: ['order_id', 'item_id'],
        columns: [
          { name: 'order_id', type: 'uuid' },
          { name: 'item_id', type: 'uuid' },
          { name: 'quantity', type: 'integer' },
        ],
      },
    ];
    const result = generateErd(tables);
    expect(result).toContain('uuid order_id PK');
    expect(result).toContain('uuid item_id PK');
  });

  it('handles table with column comments', () => {
    const tables: TableSchema[] = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text', comment: 'User email address' },
        ],
      },
    ];
    const result = generateErd(tables);
    expect(result).toContain('text email "User email address"');
  });

  it('generates valid Mermaid syntax with multiple tables and relationships', () => {
    const tables: TableSchema[] = [
      {
        table: 'departments',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'name', type: 'text' },
        ],
      },
      {
        table: 'employees',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'name', type: 'text' },
          {
            name: 'department_id',
            type: 'uuid',
            references: { table: 'departments', column: 'id' },
          },
        ],
      },
      {
        table: 'projects',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'title', type: 'text' },
          {
            name: 'lead_id',
            type: 'uuid',
            nullable: true,
            references: { table: 'employees', column: 'id' },
          },
        ],
      },
    ];
    const result = generateErd(tables);
    const lines = result.split('\n');
    expect(lines[0]).toBe('erDiagram');
    // All tables present
    expect(result).toContain('departments {');
    expect(result).toContain('employees {');
    expect(result).toContain('projects {');
    // Relationships present
    expect(result).toContain('departments ||--o{ employees : "department_id"');
    expect(result).toContain('employees |o--o{ projects : "lead_id"');
  });
});
