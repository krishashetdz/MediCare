# MediVault / MediCare – Hospital & Emergency Management System

MediVault (MediCare) is a full-stack Hospital and Emergency Management DBMS application built with **Node.js, Express, MySQL/MariaDB (3NF), MongoDB, and Vanilla HTML/JS/Bootstrap 5**.

---

## Key Capabilities & Deliberate Design Decisions

1. **Normalized 3NF Relational Schema (`db/schema.sql` — 34 Base Tables + 11 Views)**:
   - Every base table uses a single-column primary key so **2NF holds by construction**, and all transitive dependencies are removed (**3NF**): `WARD` (ward metadata), `PATIENT_ALLERGY` (1NF atomic allergies), `MEDICINE_BATCH` + `DISPENSING_RECORD`/`DISPENSING_ITEM` (FEFO batch dispensing), `PAYMENT` (partial & full payment receipts), `ADMISSION_REQUEST`, `EMERGENCY_DOCTOR_ASSIGNMENT`, `EMERGENCY_BED_ASSIGNMENT`, `AMBULANCE_DISPATCH`, and `EMERGENCY_SEQUENCE`.
   - `EMERGENCY_CASE.triage_priority` is a deliberate current-state denormalization for fast ER queue sorting, while full history is preserved in `TRIAGE_ASSESSMENT` and `EMERGENCY_PRIORITY_LOG`.
   - **Receptionist** covers billing (`sp_generate_bill`, `PAYMENT`) and front-desk emergency registration alongside appointment booking/rescheduling/cancellation; **Nurse** covers clinical triage, priority engine execution, bed allocation, and inpatient care.
2. **Timezone-Safe Date Handling**:
   - `config/db.js` configures `dateStrings: ['DATE']` on the `mysql2` pool so MySQL `DATE` columns (`appointment_date`, `dob`, `shift_date`, `start_date`, `end_date`, `expiry_date`) serialize as `'YYYY-MM-DD'` strings across both `TZ=Asia/Kolkata` and `TZ=UTC`.
3. **Hybrid MongoDB Persistence**:
   - Stores structured diagnostic lab payloads (`lab_reports_raw`), consistent audit logs (`audit_log` with `{user_id, action, table_affected, details, timestamp}`), ambulance dispatch logs (`ambulance_dispatch_log`), and notification logs (`notification_log`).

---

## How to Run from Scratch

```bash
cd project_backup/MediVault/06_Application

# 1. Create database and load schema.sql + seed.sql
mysql -u root -e "DROP DATABASE IF EXISTS medivault; CREATE DATABASE medivault CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root medivault < db/schema.sql
mysql -u root medivault < db/seed.sql

# 2. Configure .env
cp .env.example .env
# Edit .env and replace SESSION_SECRET with a random string:
# node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. Install dependencies and start server
npm install
npm start

# 4. Run end-to-end tests (under IST and UTC) and MongoDB verification
TZ=Asia/Kolkata node test-e2e.js
TZ=UTC node test-e2e.js
node scripts/verify-mongo.js
```

### Seed Login Credentials

| Role | Email | Password |
| :--- | :--- | :--- |
| **Admin** | `admin@medivault.in` | `admin1` |
| **Doctor (Cardiology)** | `sharma.doc@medivault.in` | `doc1` |
| **Doctor (Orthopedics)** | `mehta.doc@medivault.in` | `doc2` |
| **Doctor (General Medicine)** | `iyer.doc@medivault.in` | `doc3` |
| **Doctor (Emergency Medicine)** | `bhosale.doc@medivault.in` | `doc4` |
| **Nurse** | `kavita.joshi@medivault.in` | `staff1` |
| **Lab Technician** | `arjun.pillai@medivault.in` | `staff2` |
| **Pharmacist** | `neha.kapoor@medivault.in` | `staff3` |
| **Receptionist** | `suresh.rao@medivault.in` | `staff4` |
| **Patient** | `rahul.verma@gmail.com` | `pat1` |
| **Patient** | `priya.nair@gmail.com` | `pat2` |

---

## Documentation Index (`documentation/`)

- [Database Schema & Normalization (`DATABASE.md`)](documentation/DATABASE.md)
- [Entity-Relationship Diagram (`ER_DIAGRAM.md`)](documentation/ER_DIAGRAM.md)
- [DFD Level 0 (`DFD_LEVEL_0.md`)](documentation/DFD_LEVEL_0.md)
- [DFD Level 1 (`DFD_LEVEL_1.md`)](documentation/DFD_LEVEL_1.md)
- [DFD Level 2 (`DFD_LEVEL_2.md`)](documentation/DFD_LEVEL_2.md)
- [Sequence Diagrams (`SEQUENCE_DIAGRAMS.md`)](documentation/SEQUENCE_DIAGRAMS.md)
- [Activity Diagrams (`ACTIVITY_DIAGRAMS.md`)](documentation/ACTIVITY_DIAGRAMS.md)
- [Component Diagram (`COMPONENT_DIAGRAM.md`)](documentation/COMPONENT_DIAGRAM.md)
- [REST API Reference (`API_DOCUMENTATION.md`)](documentation/API_DOCUMENTATION.md)
- [User Roles & Credentials (`USER_ROLES.md`)](documentation/USER_ROLES.md)
- [Testing Report (`TESTING_REPORT.md`)](documentation/TESTING_REPORT.md)
- [Implementation Status Report (`IMPLEMENTATION_STATUS_REPORT.md`)](documentation/IMPLEMENTATION_STATUS_REPORT.md)
- [Installation Guide (`INSTALLATION.md`)](documentation/INSTALLATION.md)
- [System Architecture (`ARCHITECTURE.md`)](documentation/ARCHITECTURE.md)
