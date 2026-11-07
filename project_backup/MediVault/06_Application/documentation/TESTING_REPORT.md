# Testing & Verification Report
## MediVault / MediCare End-to-End Verification Suite (`test-e2e.js`)

### 1. Test Suite Overview
- **Test Script**: `project_backup/MediVault/06_Application/test-e2e.js`
- **Total Assertions in `test-e2e.js`**: **63** (54 original assertions + 5 receptionist appointment reschedule/cancel assertions + 4 admin staff creation assertions)
- **Dynamic Future Date**: Computed dynamically as 14 days from today (`computeFutureDate(14)`) in local time (`YYYY-MM-DD`), eliminating hardcoded past dates.
- **Database Reset Command**:
  ```bash
  mysql -u root medivault < db/schema.sql && mysql -u root medivault < db/seed.sql
  ```

### 2. Execution Status in Sandbox Environment
> **Note on Sandbox VM**: The container environment where these code updates were authored does not have `mysqld`/`mariadbd` or `mongod` server binaries installed (only Node.js v18.20.4 and syntax/unit verification tools). Therefore, live execution against MariaDB and MongoDB is marked **unverified in this sandbox** and must be run on your local machine using the commands below. All modified JavaScript files (`config/db.js`, `server.js`, `routes/*.js`, `scripts/verify-mongo.js`, `test-e2e.js`, `public/assets/js/*.js`) passed `node --check` syntax verification and local timezone unit tests (`TZ=Asia/Kolkata` and `TZ=UTC`).

### 3. Assertions Covered by `test-e2e.js` (63 Total)

1. **Section 0 — Health Check (1 assertion)**:
   - `GET /health` returns HTTP 200 `{ status: 'ok' }`.
2. **Section 1 — Security: Authentication & RBAC (16 assertions)**:
   - Rejects wrong password (`401`), legacy `'password'` (`401`), `'admin123'` (`401`), `'hash_admin1'` (`401`), and unauthenticated `/api/admin/overview` (`401`).
   - Authenticates Admin, Receptionist, Doctor 1, Doctor 2, Lab Technician, Pharmacist, and Nurse using bcrypt hashes.
   - Enforces RBAC `403` blocks across Pharmacist, Lab Technician, and Receptionist on restricted endpoints.
3. **Section 2 — Normal Patient Flow & Date Serialization (14 assertions)**:
   - Receptionist registers patient with 1NF allergies (`PATIENT_ALLERGY`).
   - Patient logs in and books an appointment on `futureDate` (`+14 days`) via `sp_book_appointment`.
   - Verifies `GET /api/patient/appointments` returns exact `YYYY-MM-DD` `appointment_date` (via `dateStrings: ['DATE']`) and derives `department_name = 'Cardiology'`.
   - Rejects duplicate slot booking (`409`).
   - Doctor confirms appointment, blocks cross-doctor consultation (`403`) and history access (`403`), records consultation + `MEDICAL_RECORD` + `ADMISSION_REQUEST`, writes 3NF prescription, orders urgent lab test, Lab Tech uploads structured report, Receptionist generates invoice (`sp_generate_bill`), and records partial (`Partial`) + final (`Paid`) payments.
4. **Section 2b — Receptionist Appointment Workflow Edges (5 assertions)**:
   - Receptionist books a second appointment slot.
   - Rescheduling to an already-taken slot returns `409 Conflict` and rolls back the cancellation of the original appointment.
   - Rescheduling to a free slot succeeds (`201`) inside a transaction using `sp_book_appointment`.
   - Cancelling the rescheduled appointment returns `200` (`status: 'Cancelled'`).
   - Re-booking the cancelled slot succeeds (`201`), proving cancellation freed the active slot.
   - Rescheduling a `Completed` appointment is blocked with `409 Conflict`.
5. **Section 3 — Pharmacy Workflow (3 assertions)**:
   - Pharmacist dispenses prescription in FEFO batch transaction (`200`), blocks re-dispensing (`409`), and rejects insufficient non-expired stock on Prescription #4 (`409`).
6. **Section 4 — Admission, Bed Turnover & Inpatient Discharge (5 assertions)**:
   - Nurse views pending `ADMISSION_REQUEST`, blocks assigning an `Occupied` bed (`409`), assigns an `Available` bed (`bed_id=5`), discharges inpatient to `Cleaning`, and marks bed `Available`.
7. **Section 5 — Emergency Workflow, Ambulance Dispatch & Priority Engine (7 assertions)**:
   - Admin dispatches ambulance (`EMERGENCY_CASE` + `AMBULANCE_DISPATCH`), Nurse records P1 triage, Priority Engine recommends Cardiology doctor & bed, Nurse allocates resources (`200`), blocks duplicate bed allocation (`409`), blocks unassigned doctor treatment (`403`), and logs assigned doctor treatment (`201`).
8. **Section 6 — Blood Bank Workflow & Emergency Discharge (6 assertions)**:
   - Doctor creates `Pending` blood request (`201`), blocks unapproved fulfillment (`409`), Admin approves (`200`) and fulfills (`200`), Doctor discharges emergency case (`200`), and Admin releases ambulance (`200`).
9. **Section 7 — Admin Staff Creation (4 assertions)**:
   - Blocks non-admin (`Receptionist`) from `POST /api/admin/staff` (`403`).
   - Admin creates `Nurse` (`USER` + `STAFF` in one transaction, `201`).
   - Rejects duplicate staff email with `409 Conflict`.
   - Newly created staff member logs in with bcrypt password (`200`).
