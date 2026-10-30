# REST API Reference
## MediCare / MediVault Hospital & Emergency Management System

### 1. Authentication Endpoints (`/api/auth`)
- `POST /api/auth/login`: Authenticate user and initialize server session.
  - Body: `{ "email": "admin@medivault.com", "password": "..." }`
  - Returns: `{ "user": { "id": 1, "name": "...", "role": "Admin", "email": "..." } }`
- `POST /api/auth/logout`: Destroy active session.
- `GET /api/auth/me`: Fetch current logged-in identity and role context.

---

### 2. Emergency Ward & Priority Engine (`/api/emergency`)
- `GET /api/emergency/dashboard`:
  - Returns: Real-time statistics including active cases, P1-P4 counts, waiting patients, available emergency beds, and doctors.
- `GET /api/emergency/queue`:
  - Returns: Dynamic priority queue sorted by severity (P1 > P2 > P3 > P4), waiting duration, and status.
- `POST /api/emergency/register`:
  - Body: `{ "patient_id", "temp_name", "age", "gender", "contact_phone", "arrival_mode", "ambulance_id", "initial_complaint", "priority" }`
  - Returns: `{ "message": "Emergency case registered", "case_id": 10, "case_number": "EMG-2026-006" }`
- `POST /api/emergency/triage/:id`:
  - Records clinical triage vitals, consciousness level, and updates case priority.
- `POST /api/emergency/priority-engine/:id`:
  - **Signature Feature**: Evaluates triage vitals, symptoms, on-duty shift rosters, doctor workloads, and bed availability.
  - Returns: `{ "recommendations": { "doctor_id", "doctor_name", "department_name", "bed_id", "bed_number", "clinical_rationale" } }`
- `POST /api/emergency/allocate/:id`:
  - Allocates doctor and bed atomically with `SELECT ... FOR UPDATE` row locking.
- `POST /api/emergency/treatment/:id`:
  - Logs physician emergency treatment orders, medications, and clinical notes.
- `POST /api/emergency/admit/:id`:
  - Admits emergency patient to General Ward or ICU, generating `ADMISSION` record.
- `POST /api/emergency/discharge/:id`:
  - Discharges patient, generates billing items, records clinical summary, and releases bed to `'Cleaning'`.

---

### 3. Blood Bank Lifecycle (`/api/resources/blood-bank`)
- `GET /api/resources/blood-bank/inventory`: 8-group stock counts.
- `GET /api/resources/blood-bank/requests`: Pending, approved, and fulfilled transfusion requests.
- `POST /api/resources/blood-bank/request`:
  - Initiates request linked to patient, doctor, and optional emergency case.
- `PUT /api/resources/blood-bank/approve/:id`:
  - Approves request (status becomes `'Approved'`; stock NOT yet deducted).
- `PUT /api/resources/blood-bank/reject/:id`:
  - Rejects request with clinical reason.
- `PUT /api/resources/blood-bank/fulfill/:id`:
  - Issues blood units and atomically decrements inventory units inside a transactional lock.

---

### 4. Nurse Clinical Workspace (`/api/staff/nurse`)
- `GET /api/staff/nurse/assigned-patients`: Ward-wise active inpatient roster.
- `POST /api/staff/nurse/vitals`: Logs BP, pulse, temperature, SpO2, and respiratory rate.
- `POST /api/staff/nurse/notes`: Logs nursing care notes, patient tolerance, and handover observations.
- `POST /api/staff/nurse/transfer-bed`: Transfers inpatient to another bed/ward with atomic bed swap.
- `GET /api/staff/nurse/emergency-monitor`: Live high-acuity patient telemetry feed.

---

### 5. Diagnostics, Pharmacy & Billing
- `GET /api/staff/lab-requests`: Pending laboratory test requests with priority flags (`Normal`, `Urgent`, `Emergency`).
- `POST /api/staff/lab-reports/:id`: Uploads completed laboratory test results.
- `GET /api/staff/prescriptions`: Pharmacist dispensing queue.
- `POST /api/staff/dispense`: Dispenses medications with transactional stock deduction.
- `POST /api/billing/invoices`: Compiles unified invoices with line items for emergency room, bed charges, pharmacy, and labs.
- `POST /api/billing/payments`: Records cash, card, insurance, or UPI payment transactions.

