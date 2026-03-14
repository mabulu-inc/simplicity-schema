---
title: Quick start
description: Get up and running in 5 minutes.
---

## 1. Install

Configure your `.npmrc` for the GitHub Packages registry (see [introduction](/simplicity-schema/getting-started/introduction/#install) for details):

```ini
@mabulu-inc:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then install:

```bash
npm install @mabulu-inc/simplicity-schema
```

## 2. Initialize project structure

```bash
npx simplicity-schema init --dir ./schema
```

This creates:

```
schema/
├── tables/
├── enums/
├── functions/
├── views/
├── roles/
├── mixins/
├── pre/
└── post/
```

## 3. Define a table

```yaml
# schema/tables/users.yaml
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
    default: gen_random_uuid()
  - name: email
    type: text
    nullable: false
    unique: true
  - name: name
    type: text
    nullable: false
  - name: created_at
    type: timestamptz
    nullable: false
    default: now()
indexes:
  - columns: [email]
    unique: true
```

## 4. Preview the plan

```bash
npx simplicity-schema plan --db postgresql://user:pass@localhost:5432/mydb
```

This shows what SQL will run without executing anything.

## 5. Run the migration

```bash
npx simplicity-schema run --db postgresql://user:pass@localhost:5432/mydb
```

## 6. Check status

```bash
npx simplicity-schema status --db postgresql://user:pass@localhost:5432/mydb
```

## 7. Detect drift

After manual DB changes or other tools modify the schema:

```bash
npx simplicity-schema drift --db postgresql://user:pass@localhost:5432/mydb
```

## Adopting on an existing database

Generate YAML from your current database:

```bash
npx simplicity-schema generate --db postgresql://user:pass@localhost:5432/mydb --output-dir ./schema
```

Then baseline so the tool knows the current state is already applied:

```bash
npx simplicity-schema baseline --db postgresql://user:pass@localhost:5432/mydb
```

## Using environment variables

Instead of passing `--db` every time:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
npx simplicity-schema plan
npx simplicity-schema run
```

Or use `SIMPLICITY_SCHEMA_DATABASE_URL` (takes precedence over `DATABASE_URL`).
