# Architecture Overview — schema-flow

## What It Does

schema-flow is a **declarative, zero-downtime PostgreSQL migration tool**. Users define their desired database state in YAML files; schema-flow diffs that desired state against the live database and generates + executes the minimal SQL to converge.

## Module Map

```
src/
├── cli/          CLI entry point (argument parsing, command dispatch)
├── core/         Foundation: config, DB pool, file discovery, logger, file tracker
│   ├── config.ts       Convention-over-configuration resolver
│   ├── config-file.ts  YAML config file + environment support
│   ├── db.ts           pg.Pool lifecycle, withClient, withTransaction, retry
│   ├── files.ts        Glob-based YAML/SQL file discovery
│   ├── logger.ts       Structured leveled logger (chalk)
│   └── tracker.ts      File hash tracker (_schema_flow_history table)
├── schema/       YAML parsing and type definitions
│   ├── types.ts        All schema interfaces (TableSchema, FunctionSchema, etc.)
│   ├── parser.ts       YAML → typed objects (one parser per schema kind)
│   └── mixins.ts       Mixin loading, interpolation, and expansion
├── introspect/   Reads current DB state via pg_catalog / information_schema
├── planner/      Diff engine: desired YAML state vs. introspected DB → Operation[]
├── executor/     Runs operations in transactions with phase ordering
├── drift/        Compares YAML to DB and reports differences (no mutations)
├── scaffold/     Generates YAML files from an existing database
├── rollback/     Snapshot capture + reverse migration (down) support
├── expand/       Zero-downtime column migrations (expand/contract pattern)
├── sql/          Generates standalone .sql migration files from a plan
├── lint/         Static analysis of migration plans for dangerous patterns
├── erd/          Mermaid ER diagram generation from YAML
├── testing/      Test infrastructure (useTestProject, helpers)
└── index.ts      Public API — re-exports from all modules
```

## Core Pipeline: YAML → Parse → Plan → Execute

The primary data flow for a migration is:

```
1. DISCOVER     core/files.ts discovers YAML files in conventional directories
                 (schema/tables/, schema/enums/, schema/functions/, etc.)

2. PARSE        schema/parser.ts reads each YAML file into typed objects
                 (TableSchema, FunctionSchema, EnumSchema, ViewSchema, etc.)

3. EXPAND       schema/mixins.ts loads mixin definitions and merges them
                 into table schemas (columns, indexes, triggers, policies)

4. INTROSPECT   introspect/index.ts queries pg_catalog to read current DB
                 state — columns, constraints, indexes, triggers, enums,
                 functions, views, roles, grants

5. PLAN         planner/index.ts diffs desired (YAML) vs. actual (DB) state
                 and produces an ordered list of Operation objects
                 (create_table, add_column, alter_column, etc.)

6. EXECUTE      executor/index.ts runs operations in phased order within
                 transactions, with advisory locking and retry support
```

## Execution Phases

The executor runs operations in a strict phase order:

```
1. PRE-SCRIPTS        Timestamped SQL scripts from schema/pre/ (run once, tracked by hash)
2. EXTENSIONS         CREATE EXTENSION statements
3. ENUMS              CREATE TYPE ... AS ENUM, ADD VALUE
4. ROLES              CREATE/ALTER ROLE, GRANT membership
5. FUNCTIONS          CREATE OR REPLACE FUNCTION
6. TABLES             CREATE TABLE, ALTER TABLE (columns, indexes, checks, FKs)
7. VIEWS              CREATE OR REPLACE VIEW
8. MATERIALIZED VIEWS CREATE MATERIALIZED VIEW, REFRESH
9. TRIGGERS           CREATE TRIGGER
10. RLS POLICIES      ENABLE RLS, CREATE POLICY
11. GRANTS            GRANT/REVOKE on tables, columns, sequences, functions
12. COMMENTS          SET COMMENT on tables, columns, indexes, etc.
13. SEEDS             INSERT/UPDATE seed rows
14. REPEATABLES       Repeatable SQL scripts (re-run when hash changes)
15. POST-SCRIPTS      Timestamped SQL scripts from schema/post/ (run once, tracked by hash)
```

## Configuration System

`core/config.ts` uses **convention-over-configuration**:

- **Base directory**: `<project>/schema/` (hardcoded subdirectory name)
- **Subdirectories**: `tables/`, `enums/`, `functions/`, `views/`, `roles/`, `pre/`, `post/`, `mixins/`, `repeatable/`
- **Connection string**: `SCHEMA_FLOW_DATABASE_URL` → `DATABASE_URL` → `--connection-string` flag
- **Schema**: defaults to `public`
- **History table**: `_schema_flow_history`
- **Safety**: destructive operations blocked by default (`--allow-destructive` to enable)
- **Timeouts**: lock_timeout=5s, statement_timeout=30s (configurable)
- **Retries**: transient errors retried up to 3 times with exponential backoff
- **Config file**: optional `schema-flow.config.yaml` with environment support

Key `SchemaFlowConfig` fields:
- `connectionString`, `baseDir`, `pgSchema`
- `tablesDir`, `enumsDir`, `functionsDir`, `viewsDir`, `rolesDir`, `preDir`, `postDir`, `mixinsDir`, `repeatableDir`
- `historyTable`, `dryRun`, `allowDestructive`
- `lockTimeout`, `statementTimeout`, `skipChecks`, `maxRetries`

## Database Connection Management

`core/db.ts` provides:
- **Singleton pool**: `getPool()` creates a single `pg.Pool` (max 5 connections)
- **`withClient(connStr, fn, opts?)`**: checkout → set timeouts → run fn → reset → release
- **`withTransaction(connStr, fn, opts?)`**: BEGIN → fn → COMMIT (or ROLLBACK on error)
- **`retryOnTimeout(fn, opts?)`**: retries on lock_timeout, statement_timeout, serialization failures, deadlocks (codes 55P03, 57014, 40001, 40P01)

## File Tracker

`core/tracker.ts` — The `FileTracker` class maintains a `_schema_flow_history` table storing:
- `file_path` (PK), `file_hash` (SHA-256), `phase` (pre/schema/post/repeatable), `applied_at`

Used to determine which files are new, changed, or unchanged. Pre/post scripts run once (tracked by path). Schema files and repeatables re-run when their hash changes.

## Schema Types Hierarchy

All types defined in `schema/types.ts`:

- **TableSchema** — table, columns[], primary_key?, indexes?, checks?, unique_constraints?, triggers?, policies?, grants?, prechecks?, seeds?, comment?
- **ColumnDef** — name, type, nullable?, default?, primary_key?, unique?, references?, expand?, generated?, comment?
- **IndexDef** — name?, columns[], unique?, where?, method?, include?, opclass?, comment?
- **CheckDef** — name?, expression, comment?
- **UniqueConstraintDef** — name?, columns[], comment?
- **TriggerDef** — name, timing, events[], function, for_each, when?, comment?
- **PolicyDef** — name, for, to?, using?, check?, permissive?, comment?
- **MixinSchema** — mixin, columns?, indexes?, checks?, triggers?, rls?, policies?, grants?
- **FunctionSchema** — name, language, returns, args?, body, security?, volatility?, parallel?, strict?, leakproof?, cost?, rows?, set?, grants?, comment?
- **FunctionArg** — name, type, mode?, default?
- **EnumSchema** — name, values[], comment?
- **ExtensionsSchema** — extensions[], schema_grants?
- **ViewSchema** — name, query, grants?, comment?
- **MaterializedViewSchema** — name, query, indexes?, grants?, comment?
- **RoleSchema** — role, login?, superuser?, createdb?, createrole?, inherit?, bypassrls?, replication?, connection_limit?, in?, comment?
- **GrantDef** — to, privileges[], columns?, with_grant_option?
- **FunctionGrantDef** — to, privileges[]
- **PrecheckDef** — name, query, message?

## Planner: Operation Types

The planner produces `Operation` objects with these types:

`create_table`, `add_column`, `alter_column`, `drop_column`, `add_index`, `add_unique_index`, `drop_index`, `add_check`, `add_check_not_valid`, `add_foreign_key`, `add_foreign_key_not_valid`, `validate_constraint`, `drop_foreign_key`, `drop_table`, `create_function`, `create_trigger`, `drop_trigger`, `enable_rls`, `disable_rls`, `create_policy`, `drop_policy`, `expand_column`, `create_dual_write_trigger`, `backfill_column`, `contract_column`, `drop_dual_write_trigger`, `create_enum`, `add_enum_value`, `create_extension`, `drop_extension`, `create_view`, `drop_view`, `create_materialized_view`, `drop_materialized_view`, `refresh_materialized_view`, `set_comment`, `create_role`, `alter_role`, `grant_membership`, `grant_table`, `grant_column`, `revoke_table`, `revoke_column`, `grant_sequence`, `revoke_sequence`, `grant_function`, `revoke_function`, `add_seed`, `run_precheck`

Key design decisions:
- CREATE TABLEs are emitted first **without** foreign keys; FKs are added later via ALTER TABLE
- Destructive operations (drops, type narrowing) are blocked unless `allowDestructive` is true
- FKs can be added as NOT VALID then validated separately (for zero-downtime)

## Secondary Features

- **Drift detection** (`drift/`): Compares YAML definitions to live DB and produces a `DriftReport` with `DriftItem[]` — no mutations, read-only
- **Scaffold** (`scaffold/`): Reverse — reads DB via introspection and generates YAML files. Also scaffolds pre/post SQL templates, mixin templates, and project init
- **Rollback** (`rollback/`): Captures `MigrationSnapshot` before each run; `computeRollback()` generates reverse operations; `runDown()` applies them
- **Expand/Contract** (`expand/`): Zero-downtime column migrations using dual-write triggers + backfill + contract phases, tracked via `ExpandTracker`
- **SQL generation** (`sql/`): Renders a migration plan as a standalone `.sql` file
- **Lint** (`lint/`): Static analysis rules applied to a plan (e.g., warns about dropping columns, long-held locks)
- **ERD** (`erd/`): Generates Mermaid ER diagrams from YAML table files

## CLI Commands

`run` (all phases), `run pre`, `run migrate`, `run post`, `plan` (dry-run), `validate`, `drift`, `lint`, `down`, `sql`, `erd`, `contract`, `expand-status`, `generate`, `baseline`, `new pre|post|mixin`, `init`, `docs`, `status`, `help`

## Public API

`src/index.ts` re-exports everything for programmatic use — config, DB pool, parsers, planner, executor, introspection, drift, scaffold, rollback, expand, SQL, ERD, lint, and all type definitions.

## Testing Strategy

- Tests use real PostgreSQL (never mocked)
- `testing/index.ts` provides `useTestProject` helper that creates isolated PG schemas
- Tests write YAML to temp directories, run migrations, and verify DB state
