# MediCare – Database Architecture, Safety & Polyglot Persistence

## 1. Database Naming & Compatibility
The MySQL schema retains the canonical database name `medivault` (`MYSQL_DATABASE=medivault`) and MongoDB retains `medivault_nosql` (`MONGO_DB=medivault_nosql`) so existing environments, scripts, and stored procedures remain 100% compatible while the user-facing application is branded **MediCare**.

## 2. Non-Destructive Schema Design (`db/schema.sql`)
- All destructive `DROP DATABASE IF EXISTS` statements have been removed from normal setup.
- All 37 relational tables use `CREATE TABLE IF NOT EXISTS` with InnoDB foreign keys, check constraints, and composite indexes.
- Application startup (`server.js`) never drops tables, truncates data, or resets records.
- `test-e2e.js` runs in an isolated test database harness and never resets a user's production database.

## 3. Incremental Migration Tracking (`SCHEMA_MIGRATIONS`)
The `SCHEMA_MIGRATIONS` table tracks every applied migration:
- `migration_id` (`INT AUTO_INCREMENT PRIMARY KEY`)
- `filename` (`VARCHAR(255) NOT NULL UNIQUE`)
- `checksum` (`VARCHAR(64) NOT NULL` — SHA-256 of the migration file)
- `applied_at` (`DATETIME DEFAULT CURRENT_TIMESTAMP`)
- `execution_ms` (`INT NOT NULL DEFAULT 0`)
- `status` (`ENUM('Applied', 'Failed', 'Rolled_Back')`)

### Migration Files (`db/migrations/`)
1. `001_baseline_schema_guard.sql`: Ensures core 3NF hospital tables and `SCHEMA_MIGRATIONS` exist.
2. `002_hardening_constraints_and_audit.sql`: Adds `assessment_status` (`ENUM('Pending_Triage','Assessed')`) and `discharged_by` to `EMERGENCY_CASE`, `recommended_doctor_id` to `EMERGENCY_DOCTOR_ASSIGNMENT`, `recommended_bed_id` and `override_reason` to `EMERGENCY_BED_ASSIGNMENT`, `temperature_unit` and `raw_payload` to `TRIAGE_ASSESSMENT`, `discharged_by` to `ADMISSION`, and `reference_key` (`UNIQUE`) to `BILL_ITEM`.
3. `003_session_and_outbox_tables.sql`: Creates `USER_SESSION` (persistent session store) and `CROSS_DB_OUTBOX` (reliable MySQL-to-MongoDB outbox queue).

## 4. Key Schema Enhancements for Clinical & Financial Integrity
- **Emergency Triage vs. Unassessed Cases (`EMERGENCY_CASE`)**:
  - `current_priority` is nullable (`ENUM('P1','P2','P3','P4') NULL DEFAULT NULL`).
  - `assessment_status` (`ENUM('Pending_Triage','Assessed') NOT NULL DEFAULT 'Pending_Triage'`) explicitly distinguishes unassessed arrivals from assessed `P3` patients.
- **Override Auditing (`EMERGENCY_DOCTOR_ASSIGNMENT`, `EMERGENCY_BED_ASSIGNMENT`)**:
  - Stores `recommended_doctor_id` / `recommended_bed_id`, `doctor_id` / `bed_id`, `override_reason`, `assigned_by`, and `assigned_at`.
- **Idempotent Billing (`BILL_ITEM.reference_key` & `sp_generate_bill`)**:
  - `BILL_ITEM.reference_key` (`VARCHAR(100) UNIQUE`) guarantees that repeated discharge or invoice requests cannot create duplicate consultation, lab, pharmacy, admission, or emergency charges.
- **Bed Cleaning State Machine (`BED.status`)**:
  - `ENUM('Available', 'Occupied', 'Cleaning', 'Maintenance')`. Inpatient and emergency discharges transition the released bed to `'Cleaning'`. Only `POST /api/resources/beds/:id/clean` transitions `'Cleaning'` to `'Available'`.

## 5. Polyglot Persistence & Cross-Database Consistency (`CROSS_DB_OUTBOX`)
- **MySQL (`medivault`)**: System of record for users, roles, appointments, consultations, prescriptions, pharmacy batches, lab requests/reports, admissions, beds, emergency cases, blood bank, ambulances, and billing.
- **MongoDB (`medivault_nosql`)**: Stores flexible document payloads in `lab_reports_raw` and `audit_log`.
- **Outbox Pattern (`services/crossDbSync.js`)**: When a lab report or audit event is saved while MongoDB is unreachable, the relational transaction commits in MySQL and records the document payload in `CROSS_DB_OUTBOX` (`status = 'Pending'`) with a unique `idempotency_key`. Once MongoDB reconnects, `reconcilePendingOutbox()` replays pending entries using `updateOne(..., { upsert: true })` so no data is lost or duplicated.
