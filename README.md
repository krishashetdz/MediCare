# MediCare – Smart Hospital & Emergency Management System

**MediCare** is a full-stack Hospital & Emergency Management System built with **Node.js, Express, MySQL 8 (3NF relational schema with triggers, views, and stored procedures), MongoDB (structured lab report payloads and audit logs), and a responsive vanilla HTML5/CSS3/JS clinical interface**.

> **Academic & Technical Notice:** All triage validation ranges, priority scoring weights, and resource recommendation rules in MediCare are configurable technical parameters designed for academic hospital workflow simulation. They are not clinically validated medical thresholds or diagnostic devices.

## Authoritative Application Location

All active application code, database scripts, incremental migrations, frontend screens, and automated verification suites reside in:

```text
project_backup/MediVault/06_Application/
```

Legacy phase deliverables (`01_ER_Schema`, `02_Relational_Model`, `03_Normalization`, `04_SQL_DDL_DML`, `05_NoSQL_Integration`, `07_Report`) are preserved under `project_backup/MediVault/` for academic reference, and superseded scratch notes are archived in `project_backup/MediVault/archive_legacy/`.

---

## Key Capabilities & Hardened Architecture

1. **Non-Destructive Database Safety & Incremental Migrations (`db/`)**
   - `db/schema.sql` uses `CREATE DATABASE IF NOT EXISTS medivault` and `CREATE TABLE IF NOT EXISTS` across all 37 tables—never dropping existing hospital databases or deleting records.
   - Fresh installation (`npm run db:install`) refuses to overwrite an existing populated database unless explicitly forced.
   - Incremental migrations (`npm run db:migrate`) track applied versions and SHA-256 checksums in `SCHEMA_MIGRATIONS` so migrations never execute twice.
   - Pre-migration backup utility (`npm run db:backup`) exports a complete logical JSON snapshot (`db/backups/`) alongside `mysqldump` instructions, and rollback SQL scripts are provided in `db/migrations/rollbacks/`.

2. **Emergency Priority Engine & Triage Validation (`routes/emergency.js`, `config/triageLimits.js`)**
   - **Explicit Assessment Status**: Newly registered emergency cases start with `assessment_status = 'Pending_Triage'` and `current_priority = NULL` (`UNASSESSED` in queue/API), never silently defaulting to `P3`.
   - **Triage Gate**: Automated priority-based recommendations require an authorized triage assessment (`Nurse`, `Doctor`, or `Admin`). Emergency staff can still perform manual emergency allocation with an explicit override reason if immediate action is required before formal triage.
   - **Strict Department Lookup (`resolveDepartmentByName`)**: Resolves requested departments by exact or normalized name and returns `matched: false` with the list of valid hospital departments when an unknown department is requested—never silently selecting the first department in the table.
   - **Multi-Factor Resource Evaluation & Re-Verification on Confirm**: Evaluates specialization, department, shift time window, approved leave (`DOCTOR_LEAVE`), active emergency workload, and bed category/status. All checks are repeated inside a `FOR UPDATE` MySQL transaction when `POST /api/emergency/allocate/:id` confirms an assignment.
   - **Audited Manual Overrides**: Overriding a recommended doctor or bed requires a non-empty `override_reason` and stores the recommended resource, selected resource, override reason, staff ID, and timestamp in `EMERGENCY_DOCTOR_ASSIGNMENT` and `EMERGENCY_BED_ASSIGNMENT`.
   - **Configurable Technical Triage Limits (`config/triageLimits.js`)**: Validates blood pressure (including `bp_systolic > bp_diastolic`), heart rate, SpO2 (`30–100%`), temperature (`°F` or `°C` with automatic conversion and unit preservation), respiratory rate, AVPU consciousness level, and clinical observations while preserving `raw_payload`.

3. **Transactional Admission, Discharge, Bed Cleaning & Billing Idempotency**
   - Prevents duplicate inpatient admissions (`409 Conflict`) and duplicate discharges (`409 Conflict`) using row-level `SELECT ... FOR UPDATE` locks.
   - Enforces the bed release state machine: `Occupied -> Cleaning -> Available`. Discharging an inpatient or emergency patient transitions the released bed to `Cleaning`; authorized staff must confirm cleaning (`POST /api/resources/beds/:id/clean`) before the bed becomes `Available`.
   - Prevents duplicate billing entries via unique `reference_key` constraints on `BILL_ITEM` (`ADM-DISCHARGE-<admission_id>`, `EMG-DISCHARGE-<case_id>`, `CONSULT-FEE-<appointment_id>`, `LAB-REQ-<request_id>`, `DISPENSE-<dispensing_id>`) and an idempotent `sp_generate_bill` stored procedure.

4. **MySQL & MongoDB Resilience (`config/db.js`, `services/crossDbSync.js`)**
   - Separate liveness (`GET /health/live`) and readiness (`GET /health/ready`, `GET /health`) endpoints that run real `SELECT 1` and `ping` checks and accurately report `ok`, `degraded` (`degraded_mongo_offline`), or `error` (`503 Service Unavailable`).
   - Cross-database outbox (`CROSS_DB_OUTBOX`) queues structured MongoDB writes (`lab_reports_raw`, `audit_log`) whenever MongoDB is temporarily unreachable and reconciles them automatically or via `POST /api/admin/reconcile-outbox`.

5. **Persistent Sessions & Role-Based Access Control (`config/sessionStore.js`, `middleware/auth.js`)**
   - Sessions are persisted in MySQL (`USER_SESSION`) rather than volatile in-memory storage, with `HttpOnly`, `SameSite=lax`, configurable `Secure` cookies, `trust proxy` support, session ID regeneration on login, and immediate database invalidation on logout.
   - Enforces strict role boundaries across all 7 roles (`Admin`, `Doctor`, `Nurse`, `Lab Technician`, `Pharmacist`, `Receptionist`, `Patient`) and blocks cross-doctor and cross-patient data access.

---

## Quick Start

```bash
cd project_backup/MediVault/06_Application
cp .env.example .env
# Edit .env with your MYSQL_*, MONGO_*, and SESSION_SECRET values

# 1. Fresh database setup (only on an empty database):
npm run db:install -- --seed

# 2. Or apply incremental migrations to an existing database (preserves all data):
npm run db:backup
npm run db:migrate

# 3. Start the server:
npm start

# 4. Run the automated verification suites:
TZ=Asia/Kolkata npm test
TZ=UTC npm test
npm run test:browser
```

See [`project_backup/MediVault/06_Application/README.md`](project_backup/MediVault/06_Application/README.md) and the files in [`project_backup/MediVault/06_Application/documentation/`](project_backup/MediVault/06_Application/documentation/) for full installation, database migration, API, and testing documentation.
