# MediCare – API Documentation

All API endpoints under `/api/*` use JSON payloads and session-cookie authentication (`medicare.sid`, `HttpOnly`, `SameSite=lax`). Unauthenticated requests return `401 Unauthorized`; insufficient role permissions return `403 Forbidden`.

## 1. Health & Readiness Endpoints
- `GET /health/live`: Process liveness probe (`200 OK`, `{ status: 'alive' }`).
- `GET /health/ready`: Database readiness probe (`200 OK` when MySQL is reachable, `503 Service Unavailable` when MySQL is offline).
- `GET /health`: Detailed health check for MySQL (`connected`, latency) and MongoDB (`connected`, `readiness: 'ready' | 'degraded_mongo_offline' | 'not_ready_mysql_offline'`).

## 2. Authentication & Profile (`/api/auth`, `/api/profile`)
- `POST /api/auth/login`: Authenticates `{ email, password }` against bcrypt hashes, regenerates session ID, persists session in `USER_SESSION`, and returns `{ user, redirect }`.
- `POST /api/auth/logout`: Destroys session in `USER_SESSION` and clears cookie.
- `GET /api/auth/me`: Returns active session user or `401`.
- `GET /api/profile`: Returns current user's profile and role metadata.
- `PUT /api/profile`: Updates phone/address or password (verifying `current_password`).

## 3. Emergency Ward & Priority Engine (`/api/emergency`)
- `GET /api/emergency/dashboard`: KPI summary (`active_cases`, `critical_cases`, `urgent_cases`, `waiting_patients`, `available_emergency_beds`, `available_emergency_doctors`).
- `GET /api/emergency/queue`: Live queue ordered by assessed priority (`P1`–`P4`) + wait time, with unassessed cases marked `triage_priority: 'UNASSESSED'`, `assessment_status: 'Pending_Triage'`, `triage_pending: true`.
- `POST /api/emergency/register`: Registers walk-in, ambulance, or unknown/temporary emergency arrival (`assessment_status = 'Pending_Triage'`, `current_priority = NULL` unless initial triage is recorded). Validates `requested_department` via `resolveDepartmentByName` (returns `400` with `available_departments` if invalid).
- `POST /api/emergency/triage/:id`: Validates vital signs against `config/triageLimits.js` (`bp_systolic`, `bp_diastolic`, `heart_rate`, `spo2`, `temperature`, `temperature_unit` `F`/`C`, `respiratory_rate`, `consciousness_level`, `symptoms`/`injury_details`/`assessment_notes`), stores `TRIAGE_ASSESSMENT`, and marks `assessment_status = 'Assessed'`.
- `GET /api/emergency/priority-engine/:id`:
  - If `assessment_status === 'Pending_Triage'`, returns `triage_pending: true` and withholds normal automated recommendations while providing available rosters for manual emergency handling.
  - If assessed, returns `recommended_department`, `recommended_doctor` (with factual `reason`), `recommended_bed` (with factual `reason`), `excluded_doctors` (with factual `excluded_reason`), and `excluded_beds`.
  - If `?department=<invalid>` is passed, returns `404` with `matched: false` and `available_departments`.
- `POST /api/emergency/allocate/:id`: Repeats all doctor availability, active status, shift window, leave status, workload, and bed `FOR UPDATE` lock checks inside a MySQL transaction. Requires `override_reason` (`400 Bad Request`) whenever a non-recommended doctor or bed is selected or when allocating before triage.
- `POST /api/emergency/treatment/:id`: Records treatment action (`Medication`, `Procedure`, `Observation`, `Escalation`, `Note`).
- `POST /api/emergency/admit/:id`: Transfers emergency patient to inpatient `ADMISSION` inside a transaction (`409` if already admitted).
- `POST /api/emergency/discharge/:id`: Idempotent emergency discharge (`409` if already discharged), transitions bed to `'Cleaning'`, records `discharged_by`, and creates a single `EMG-DISCHARGE-<case_id>` bill item.
- `GET /api/emergency/doctors` & `GET /api/emergency/beds`: Live duty roster and bed occupancy matrix.

## 4. Doctor Portal (`/api/doctor`)
- `GET /api/doctor/schedule`: Returns doctor's full schedule, `todaySchedule`, and `upcomingAppointments`.
- `PATCH /api/doctor/appointments/:id/status`: Confirms or cancels own appointment (`403` for other doctors' appointments).
- `POST /api/doctor/consultations`: Transactional save of `CONSULTATION`, `MEDICAL_RECORD`, optional `PRESCRIPTION` + `PRESCRIPTION_ITEM`s, optional `LAB_REQUEST`s, and optional `ADMISSION_REQUEST`. Idempotent on retry for the same `appointment_id`.
- `POST /api/doctor/prescriptions` & `POST /api/doctor/lab-requests`: Standalone multi-item prescription and lab request endpoints.
- `GET /api/doctor/patients/:id/history`: Full clinical timeline (restricted to patients treated by the logged-in doctor).

## 5. Staff Portal (`/api/staff`)
- `POST /api/staff/receptionist/register-patient`: Creates `USER` + `PATIENT` + `PATIENT_ALLERGY` (`409` on duplicate email).
- `POST /api/staff/receptionist/generate-bill`: Calls idempotent `sp_generate_bill`.
- `POST /api/staff/lab-tech/requests/:id/report`: Saves `LAB_REPORT` in MySQL and structured parameters in MongoDB `lab_reports_raw` (or queues in `CROSS_DB_OUTBOX` if MongoDB is offline; `409` on duplicate upload).
- `POST /api/staff/pharmacist/dispense/:prescriptionId`: Deducts non-expired `MEDICINE_BATCH` stock in FEFO order (`409` if already dispensed or insufficient stock).
- `POST /api/staff/nurse/admission-requests/:id/assign-bed`: Assigns an `'Available'` bed (`FOR UPDATE`) and creates `ADMISSION` (`409` if bed is not `'Available'` or patient already admitted).
- `POST /api/staff/nurse/discharge/:admissionId`: Idempotent inpatient discharge (`409` if already discharged), transitions bed to `'Cleaning'`, and bills exact stay days via `ADM-DISCHARGE-<admission_id>`.

## 6. Hospital Resources & Admin (`/api/resources`, `/api/admin`, `/api/billing`)
- `POST /api/resources/beds/:id/clean` (alias `PUT /api/resources/beds/:id/clean`): Confirms cleaning of a `'Cleaning'` bed and transitions it to `'Available'`.
- `POST /api/resources/blood-bank/requests`: Creates blood request.
- `PATCH /api/resources/blood-bank/requests/:id`: Approves (`Approved`), rejects (`Rejected`), or fulfills (`Fulfilled`, only after `Approved`, deducting `BLOOD_BANK.available_units` once).
- `POST /api/admin/ambulances`: Registers a new ambulance (`409` on duplicate `vehicle_number`).
- `PATCH /api/admin/ambulance/:id`: Updates ambulance driver name, phone, or status.
- `POST /api/admin/ambulance/:id/dispatch`: Dispatches an `Available` ambulance, links existing patient or creates temporary emergency case, and logs `AMBULANCE_DISPATCH`.
- `POST /api/admin/ambulance/:id/arrive`: Completes active dispatch and marks ambulance `Available`.
- `POST /api/admin/reconcile-outbox`: Reconciles pending `CROSS_DB_OUTBOX` items to MongoDB.
- `POST /api/billing/:id/payments`: Records partial or full payment (`409` on duplicate `reference_no` or overpayment).
