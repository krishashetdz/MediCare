# MediVault — Full Codebase

Hybrid MySQL + MongoDB hospital management system. 7 phases, one project.

## Run order

1. **02_DDL_DML/medivault_phase2_ddl_dml.sql** — creates the database + all 21
   tables + sample data. Run this first, always.
2. **03_Queries/medivault_phase3_queries.sql** — starts with a small
   supplement block (adds a 2nd Cardiology doctor, a 3rd doctor for one
   patient, fuller bed occupancy) so the self-join/occupancy/">2 doctors"
   queries have real results, then runs all 64 SELECT queries.
3. **04_Views_Triggers_Procs/medivault_phase4_views_triggers_procs.sql** —
   schema objects only (6 views, 7 triggers, 2 procedures). Does not touch
   your data.
4. **04_Views_Triggers_Procs/medivault_phase4_demo.sql** *(optional)* — run
   this after step 3 if you want to see the triggers/procedures fire live
   (inserts test rows, dispenses a prescription, books an appointment, etc.)
   — good for screenshots.
5. **05_MongoDB/medivault_phase5_mongodb.js** — MongoDB shell commands for
   the 3 hybrid collections. Independent of the MySQL steps; run against a
   `mongosh` connection whenever you set one up.
6. **06_Application/** — the Node/Express + Bootstrap app. See its own
   README.md inside for setup. Needs steps 1–3 loaded into MySQL first (step
   4 optional, step 5 only if you want live notifications/lab-raw data
   instead of the graceful-degradation fallback).
7. **07_Report/medivault_phase7_report.docx** — the college report:
   abstract, ER diagram, schema, normalization proof, experiment summary,
   view/trigger/procedure docs, screenshots checklist, conclusion, and 20
   viva Q&A. Open the Table of Contents and hit "Update Field" in Word so
   page numbers populate.

## What's been tested

Everything in steps 1–4 was executed against a live MySQL-compatible server
(errors checked, results spot-verified against hand-calculated expectations)
before being written here — not hand-simulated. Step 5's CRUD logic was
validated against a live Mongo-compatible engine (mongomock) with the same
document shapes shown in the file. Step 6 was run as a real server and
exercised with curl across every role (login, RBAC 403s, double-booking
409s, insufficient-stock 409s) — see `06_Application/README.md` for the
exact list.

## Folder map

```
01_ER_Schema/            Phase 1 — ER diagram, full schema, normalization proof
02_DDL_DML/               Phase 2 — CREATE TABLE + constraints + sample data
03_Queries/                Phase 3 — SELECT / joins / subqueries / set ops / GROUP BY
04_Views_Triggers_Procs/    Phase 4 — views, triggers, stored procedures (+ demo)
05_MongoDB/                  Phase 5 — hybrid MongoDB module
06_Application/                Phase 6 — Node/Express + Bootstrap app
07_Report/                      Phase 7 — the college report (.docx) + viva prep
```
