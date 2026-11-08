# MediCare – Application Guide (`06_Application`)

This directory is the authoritative application root for **MediCare – Smart Hospital & Emergency Management System**.

## Directory Structure

```text
06_Application/
├── config/
│   ├── db.js                  # MySQL pool, MongoDB client, live health probes & simulated outage hooks
│   ├── sessionStore.js        # Persistent MySQL session store (USER_SESSION table)
│   └── triageLimits.js        # Configurable technical validation limits for triage vitals
├── db/
│   ├── schema.sql             # Non-destructive 3NF MySQL DDL (37 tables, views, triggers, procedures)
│   ├── seed.sql               # Idempotent canonical demo dataset (INSERT IGNORE)
│   ├── install-fresh.js       # Safe installer for empty databases (blocks overwriting populated DBs)
│   ├── migrate.js             # Incremental migration runner tracked via SCHEMA_MIGRATIONS
│   ├── backup.js              # Pre-migration logical backup utility (exports JSON snapshot)
│   └── migrations/            # Versioned SQL migrations + rollbacks/
├── middleware/
│   └── auth.js                # Session authentication & RBAC middleware
├── routes/
│   ├── auth.js                # Login (bcrypt + session regeneration), logout, /me
│   ├── admin.js               # Analytics, staff/doctor CRUD, ambulance fleet & outbox reconciliation
│   ├── doctor.js              # Schedule, transactional consultation, prescriptions, lab requests
│   ├── staff.js               # Receptionist, Nurse, Lab Tech & Pharmacist workflows
│   ├── patient.js             # Patient appointments, reschedule/cancel, prescriptions, vitals, bills
│   ├── emergency.js           # Emergency registration, triage, Priority Engine, allocation & discharge
│   ├── resources.js           # Wards, beds, bed cleaning confirmation, blood bank & ambulance
│   ├── billing.js             # Invoices, line items, and idempotent payment recording
│   └── profile.js             # Self-service profile & password update
├── services/
│   ├── crossDbSync.js         # MySQL <-> MongoDB outbox consistency & automatic reconciliation
│   └── notificationService.js # Role & user notifications
├── public/                    # Responsive HTML5/CSS3/JS frontend screens (Dark/Light mode)
├── tests/                     # Browser E2E suite (test-browser-e2e.py) & isolated test harness
├── documentation/             # Complete system, API, database, installation & testing docs
├── server.js                  # Express application entrypoint & /health endpoints
└── test-e2e.js                # Master E2E verification suite (Tests A through J, 86 assertions)
```

---

## 1. Environment Configuration (`.env`)

Copy `.env.example` to `.env` and configure:

| Variable | Default / Example | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | `development` | Environment (`development`, `test`, `production`) |
| `MYSQL_HOST` | `localhost` | MySQL 8 / MariaDB 10.6+ host |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_USER` | `root` | MySQL username |
| `MYSQL_PASSWORD` | *(your password)* | MySQL password |
| `MYSQL_DATABASE` | `medivault` | Relational database name (kept as `medivault` for compatibility) |
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGO_DB` | `medivault_nosql` | MongoDB database name |
| `SESSION_SECRET` | *(required secret)* | Cryptographic secret for signing `medicare.sid` session cookies |
| `SESSION_COOKIE_NAME` | `medicare.sid` | Session cookie name |
| `SESSION_TTL_MS` | `28800000` | Session lifetime in ms (default 8 hours) |
| `TRUST_PROXY` | `1` (in prod) | Enables secure cookies behind a reverse proxy |

---

## 2. Safe Database Installation vs. Incremental Upgrades

### A. Fresh Installation (Empty Database Only)
```bash
npm run db:install -- --seed
```
- Inspects the target database first. If existing tables with hospital records are detected, `db/install-fresh.js` **aborts safely** (`skipped_existing_data`) and instructs you to run `npm run db:migrate` instead.
- Applies `db/schema.sql`, records all baseline migrations in `SCHEMA_MIGRATIONS`, and optionally loads `db/seed.sql` when `--seed` is passed.

### B. Backing Up Before Upgrades
```bash
# Option 1: Built-in logical JSON backup utility (writes to db/backups/)
npm run db:backup

# Option 2: Native mysqldump CLI backup
mysqldump -u root -p --routines --triggers --single-transaction medivault > backup_$(date +%F_%H%M%S).sql
```

### C. Incremental Migrations (Existing Databases)
```bash
# Check migration status:
npm run db:migrate:status

# Apply pending migrations:
npm run db:migrate
```
- Reads `db/migrations/*.sql` in lexical order (`001_baseline_schema_guard.sql`, `002_hardening_constraints_and_audit.sql`, `003_session_and_outbox_tables.sql`).
- Skips any migration already recorded as `Applied` in `SCHEMA_MIGRATIONS` and verifies SHA-256 checksums.
- Rollback SQL scripts are located in `db/migrations/rollbacks/*.down.sql`.

---

## 3. Running & Testing the Application

```bash
# Start the Express server
npm start

# Run backend & database E2E verification suite (86 assertions across Tests A-J)
TZ=Asia/Kolkata npm test
TZ=UTC npm test

# Run headless Chromium browser verification suite (16 assertions in Test K)
npm run test:browser
```

---

## 4. Demonstration Credentials (`db/seed.sql`)

| Role | Email | Password | Landing Page |
|---|---|---|---|
| **Admin** | `admin@medivault.in` | `admin1` | `/admin-dashboard.html` |
| **Doctor (Cardiology)** | `sharma.doc@medivault.in` | `doc1` | `/doctor-dashboard.html` |
| **Doctor (Neurology)** | `mehta.doc@medivault.in` | `doc2` | `/doctor-dashboard.html` |
| **Nurse** | `kavita.joshi@medivault.in` | `staff1` | `/staff-portal.html` |
| **Lab Technician** | `arjun.pillai@medivault.in` | `staff2` | `/staff-portal.html` |
| **Pharmacist** | `neha.kapoor@medivault.in` | `staff3` | `/staff-portal.html` |
| **Receptionist** | `suresh.rao@medivault.in` | `staff4` | `/staff-portal.html` |
| **Patient** | `rahul.verma@gmail.com` | `pat1` | `/patient-portal.html` |
| **Patient** | `priya.nair@gmail.com` | `pat2` | `/patient-portal.html` |
