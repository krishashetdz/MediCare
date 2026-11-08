# MediCare – Installation, Upgrade & Backup Guide

## 1. Prerequisites
- **Node.js**: v18.x or newer
- **MySQL**: v8.0+ (or MariaDB 10.6+)
- **MongoDB**: v6.0+ (optional for core relational workflows; required for live raw lab report document storage without outbox queuing)

## 2. Environment Setup
1. Navigate to the application root:
   ```bash
   cd project_backup/MediVault/06_Application
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create `.env` from `.env.example`:
   ```bash
   cp .env.example .env
   ```
   Set a strong `SESSION_SECRET` (required in all environments) and configure `MYSQL_*` and `MONGO_*` connection parameters.

## 3. Safe Database Initialization (New Installations Only)
Unlike earlier versions that contained `DROP DATABASE IF EXISTS medivault;`, the schema and installer are strictly non-destructive:
```bash
# Install schema + canonical demo seed data on a new/empty database:
npm run db:install -- --seed

# Or install schema only (no demo seed data):
npm run db:install
```
If `db/install-fresh.js` detects existing `USER` or `PATIENT` records in `medivault`, it refuses to overwrite the database and exits safely with status `skipped_existing_data`.

## 4. Database Backup Before Upgrades
Always back up the database before running migrations:
```bash
# Built-in JSON logical backup (saved to db/backups/backup_medivault_<timestamp>.json):
npm run db:backup

# Or using mysqldump:
mysqldump -u root -p --routines --triggers --single-transaction medivault > medivault_pre_migration.sql
```

## 5. Incremental Database Migrations (Existing Installations)
To upgrade an existing `medivault` database without losing any records:
```bash
# 1. Inspect applied vs. pending migrations:
npm run db:migrate:status

# 2. Apply pending migrations:
npm run db:migrate
```
Each migration in `db/migrations/` is recorded in `SCHEMA_MIGRATIONS` with its SHA-256 checksum and execution timestamp so it is never applied twice.

### Rollback Instructions
If a migration needs to be reverted manually after a backup:
- To revert `003_session_and_outbox_tables.sql`:
  ```bash
  mysql -u root -p medivault < db/migrations/rollbacks/003_session_and_outbox_tables.down.sql
  ```
- To revert `002_hardening_constraints_and_audit.sql`:
  ```bash
  mysql -u root -p medivault < db/migrations/rollbacks/002_hardening_constraints_and_audit.down.sql
  ```

## 6. Starting the Server & Checking Health
```bash
npm start
```
Verify liveness and database readiness:
- `GET http://localhost:3000/health/live` – Process liveness (`200 OK`)
- `GET http://localhost:3000/health/ready` – Readiness probe (`200 OK` when MySQL is ready, `503` if MySQL is offline)
- `GET http://localhost:3000/health` – Detailed status of MySQL (`connected`, latency) and MongoDB (`connected`, outbox status)
