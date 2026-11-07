# MediVault / MediCare — Hospital DBMS Project

Hybrid MySQL/MariaDB (3NF) + MongoDB hospital and emergency management system.

## Canonical Database & Application Files

- **`06_Application/db/schema.sql`** — Canonical 3NF DDL (34 base tables, 11 views, 4 triggers, 2 stored procedures).
- **`06_Application/db/seed.sql`** — Canonical seed data with bcrypt password hashes for all 7 roles.
- **`06_Application/`** — Node/Express + Vanilla HTML/JS/Bootstrap 5 application, `test-e2e.js`, `scripts/verify-mongo.js`, and `documentation/`.
- **`01_ER_Schema/`**, **`02_DDL_DML/`**, **`03_Queries/`**, **`04_Views_Triggers_Procs/`**, **`05_MongoDB/`**, **`07_Report/`** — Phase deliverables.

See [`06_Application/README.md`](06_Application/README.md) for complete setup and run-from-scratch instructions.
