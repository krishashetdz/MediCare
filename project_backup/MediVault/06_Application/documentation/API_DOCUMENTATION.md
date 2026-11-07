# REST API Documentation
## Complete Route Inventory & Role Authorization Matrix

This inventory is generated directly from `server.js` and `routes/*.js` (`auth.js`, `resources.js`, `admin.js`, `doctor.js`, `patient.js`, `staff.js`, `billing.js`, `profile.js`, `emergency.js`).

### 1. System & Health (`server.js`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Public | Redirects to `/login.html` |
| `GET` | `/health` | Public | Returns `{ "status": "ok" }` |
| `GET` | `/runtime-config.js` | Public | Supplies `window.MV_API_BASE` to browser pages |

### 2. Authentication (`routes/auth.js` -> `/api/auth`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Public | Authenticates email & password via `bcrypt.compare` |
| `POST` | `/api/auth/logout` | Public | Destroys current session |
| `GET` | `/api/auth/me` | Public | Returns current session user or `{ user: null }` |

### 3. Shared Operational Resources (`routes/resources.js` -> `/api/admin`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/blood-bank` | `Admin`, `Doctor`, `Nurse` | Lists 8 blood group inventory levels (`BLOOD_BANK`) |
| `GET` | `/api/admin/blood-bank/requests` | `Admin`, `Doctor`, `Nurse` | Lists blood requests with patient, case, and requester details |
| `POST` | `/api/admin/blood-bank/request` | `Admin`, `Doctor`, `Nurse` | Creates a `Pending` blood request and logs to `audit_log` |
| `POST` | `/api/admin/blood-bank/requests/:id/approve` | `Admin`, `Doctor` | Approves a `Pending` blood request |
| `POST` | `/api/admin/blood-bank/requests/:id/reject` | `Admin`, `Doctor` | Rejects a `Pending` blood request |
| `POST` | `/api/admin/blood-bank/requests/:id/fulfill` | `Admin`, `Doctor`, `Nurse` | Atomically deducts `BLOOD_BANK` stock for an `Approved` request |
| `GET` | `/api/admin/ambulances` | `Admin`, `Receptionist`, `Doctor`, `Nurse` | Lists ambulance fleet with active dispatch details |
| `POST` | `/api/admin/ambulance/:id/dispatch` | `Admin`, `Receptionist` | Dispatches ambulance, creates linked `EMERGENCY_CASE` + `AMBULANCE_DISPATCH`, logs to Mongo |
| `POST` | `/api/admin/ambulance/:id/release` | `Admin`, `Receptionist`, `Nurse` | Completes dispatch and marks ambulance `Available` |

### 4. Administration & Hospital Governance (`routes/admin.js` -> `/api/admin`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/doctors` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Lists doctors with department, specialization, and fee |
| `GET` | `/api/admin/patients` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Searches patients by name, email, or phone (`?q=`) |
| `GET` | `/api/admin/beds` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Lists beds across wards via `vw_bed_details` |
| `GET` | `/api/admin/beds/:id` | `Admin`, `Nurse` | Returns single bed details and occupant info |
| `PATCH` | `/api/admin/beds/:id` | `Admin`, `Nurse` | Assigns or releases a bed inside a transaction (`FOR UPDATE`) |
| `GET` | `/api/admin/dashboard` | `Admin` | Returns hospital KPIs, `vw_monthly_revenue`, and `vw_bed_occupancy` |
| `POST` | `/api/admin/doctors` | `Admin` | Creates `USER` + `DOCTOR` in one transaction with bcrypt password |
| `PUT` | `/api/admin/doctors/:id` | `Admin` | Updates doctor specialization, qualification, and fee |
| `DELETE` | `/api/admin/doctors/:id` | `Admin` | Removes a doctor user if no history blocks deletion |
| `GET` | `/api/admin/notifications` | `Admin` | Lists latest 50 notifications for logged-in Admin |
| `PATCH` | `/api/admin/notifications/mark-all-read` | `Admin` | Marks all Admin notifications as read |
| `GET` | `/api/admin/emergencies/count` | `Admin` | Counts active emergency cases |
| `GET` | `/api/admin/ambulances/available` | `Admin` | Counts available ambulances |
| `GET` | `/api/admin/appointments/by-department` | `Admin` | Aggregates appointment counts by department |
| `GET` | `/api/admin/appointments` | `Admin` | Lists recent appointments (`?limit=&status=`) |
| `GET` | `/api/admin/patients/all` | `Admin` | Lists all patients with `vw_patient_allergies` |
| `GET` | `/api/admin/departments/detail` | `Admin` | Lists departments with HOD name and doctor count |
| `GET` | `/api/admin/departments` | `Admin` | Lists department IDs and names |
| `GET` | `/api/admin/staff` | `Admin` | Lists all hospital staff with optional `?role=` filter |
| `POST` | `/api/admin/staff` | `Admin` | Creates `Nurse`, `Lab Technician`, `Pharmacist`, or `Receptionist` (`USER` + `STAFF` transaction, 409 on duplicate email) |
| `GET` | `/api/admin/doctor-shifts` | `Admin` | Lists upcoming and current doctor shifts |
| `POST` | `/api/admin/doctor-shifts` | `Admin` | Creates a doctor shift record |

### 5. Doctor Workspace (`routes/doctor.js` -> `/api/doctor`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/doctor/schedule` | `Doctor` | Lists doctor's today and upcoming 30-day appointments |
| `PATCH` | `/api/doctor/appointments/:id/status` | `Doctor` | Updates appointment status (`Confirmed`, `Checked In`, `Cancelled`, `Scheduled`) |
| `GET` | `/api/doctor/my-patients` | `Doctor` | Lists patients associated with the logged-in doctor |
| `GET` | `/api/doctor/patients/:patientId/history` | `Doctor` | Returns medical records, consultations, and lab reports for an owned patient |
| `GET` | `/api/doctor/lab-reports` | `Doctor` | Lists lab reports ordered by or belonging to the doctor's patients (merged with Mongo `lab_reports_raw`) |
| `GET` | `/api/doctor/patients/:patientId/lab-reports` | `Doctor` | Lists lab reports for a specific owned patient |
| `POST` | `/api/doctor/consultations` | `Doctor` | Records consultation, marks appointment `Completed`, syncs `MEDICAL_RECORD`, and optionally creates `ADMISSION_REQUEST` |
| `POST` | `/api/doctor/prescriptions` | `Doctor` | Creates 3NF `PRESCRIPTION` and `PRESCRIPTION_ITEM` rows |
| `POST` | `/api/doctor/lab-requests` | `Doctor` | Creates `LAB_REQUEST` with priority (`Normal`, `Urgent`, `Emergency`) |
| `GET` | `/api/doctor/medicines/search` | `Doctor` | Searches medicines via `vw_medicine_inventory` |
| `GET` | `/api/doctor/lab-tests` | `Doctor` | Lists diagnostic tests from `LAB_TEST` |
| `GET` | `/api/doctor/notifications` | `Doctor` | Lists notifications for the logged-in doctor |
| `PATCH` | `/api/doctor/notifications/mark-all-read` | `Doctor` | Marks doctor notifications as read |
| `GET` | `/api/doctor/emergency-cases` | `Doctor` | Lists active emergency cases assigned to the doctor |
| `GET` | `/api/doctor/shifts` | `Doctor` | Lists recent and upcoming shifts for the doctor |

### 6. Patient Portal (`routes/patient.js` -> `/api/patient`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/patient/summary` | `Patient` | Returns `vw_patient_portal_summary` for logged-in patient |
| `POST` | `/api/patient/book-appointment` | `Patient` | Books appointment via `sp_book_appointment` |
| `GET` | `/api/patient/appointments` | `Patient` | Lists patient's appointments with derived department |
| `POST` | `/api/patient/appointments/:id/cancel` | `Patient` | Cancels patient's own `Scheduled`/`Confirmed` appointment |
| `GET` | `/api/patient/doctor-reports` | `Patient` | Lists patient's consultation reports |
| `GET` | `/api/patient/records` | `Patient` | Lists patient's `MEDICAL_RECORD` history |
| `GET` | `/api/patient/bills` | `Patient` | Lists patient's invoices from `vw_bill_summary` |
| `GET` | `/api/patient/lab-reports` | `Patient` | Lists patient's lab reports merged with Mongo `lab_reports_raw` |
| `GET` | `/api/patient/notifications` | `Patient` | Lists patient notifications |
| `PATCH` | `/api/patient/notifications/:id/read` | `Patient` | Marks a notification as read |
| `GET` | `/api/patient/departments` | `Patient` | Lists departments for booking wizard |
| `GET` | `/api/patient/doctors` | `Patient` | Lists doctors filtered by `?department_id=` |
| `GET` | `/api/patient/available-slots` | `Patient` | Returns free 30-min slots (`09:00:00`–`16:30:00`) for `?doctor_id=&appointment_date=` |
| `GET` | `/api/patient/prescriptions` | `Patient` | Lists patient's prescriptions |
| `GET` | `/api/patient/prescriptions/:id/items` | `Patient` | Lists line items for a patient's prescription |

### 7. Clinical & Front-Desk Staff (`routes/staff.js` -> `/api/staff`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/staff/nurse/beds` | `Admin`, `Nurse` | Lists beds via `vw_bed_details` |
| `GET` | `/api/staff/nurse/ward/:wardName/patients` | `Admin`, `Nurse` | Lists occupied beds and patients in a ward |
| `GET` | `/api/staff/nurse/assigned-patients` | `Admin`, `Nurse` | Lists all active inpatients with latest vitals and notes |
| `GET` | `/api/staff/nurse/admission-requests` | `Admin`, `Nurse` | Lists pending doctor `ADMISSION_REQUEST` rows |
| `GET` | `/api/staff/nurse/available-beds` | `Admin`, `Nurse` | Lists available beds (optionally prioritized by `?ward=`) |
| `POST` | `/api/staff/nurse/assign-admission-bed` | `Admin`, `Nurse` | Assigns an `Available` bed to an `ADMISSION_REQUEST` and creates `ADMISSION` |
| `POST` | `/api/staff/nurse/discharge-inpatient` | `Admin`, `Nurse`, `Doctor` | Discharges inpatient, posts room fee to `BILL_ITEM`, sets bed to `Cleaning` |
| `POST` | `/api/staff/nurse/beds/:id/mark-available` | `Admin`, `Nurse` | Marks a `Cleaning`/`Maintenance` bed as `Available` |
| `POST` | `/api/staff/nurse/vitals` | `Admin`, `Nurse` | Records `PATIENT_VITALS` (alerting doctors if critical) |
| `GET` | `/api/staff/nurse/vitals/:patientId` | `Admin`, `Nurse`, `Doctor` | Lists vital sign history for a patient |
| `POST` | `/api/staff/nurse/notes` | `Admin`, `Nurse` | Records a `NURSE_NOTE` |
| `GET` | `/api/staff/nurse/notes/:patientId` | `Admin`, `Nurse`, `Doctor` | Lists nursing care notes for a patient |
| `POST` | `/api/staff/nurse/transfer-bed` | `Admin`, `Nurse` | Atomically transfers a patient from current bed to a new `Available` bed |
| `GET` | `/api/staff/nurse/emergency-monitor` | `Admin`, `Nurse` | Returns active high-acuity emergency cases with latest vitals |
| `GET` | `/api/staff/nurse/notifications` | `Admin`, `Nurse` | Lists notifications for logged-in nurse |
| `GET` | `/api/staff/lab-tech/pending-requests` | `Admin`, `Lab Technician` | Lists pending `LAB_REQUEST` rows ordered by priority |
| `POST` | `/api/staff/lab-tech/requests/:id/report` | `Admin`, `Lab Technician` | Inserts `LAB_REPORT`, upserts Mongo `lab_reports_raw`, marks request `Completed` |
| `GET` | `/api/staff/lab-tech/completed-reports` | `Admin`, `Lab Technician`, `Doctor` | Lists completed lab reports |
| `GET` | `/api/staff/lab-tech/reports/:reportId` | `Admin`, `Lab Technician`, `Doctor` | Returns single lab report merged with Mongo `lab_reports_raw` |
| `GET` | `/api/staff/pharmacist/pending-prescriptions` | `Admin`, `Pharmacist` | Lists pending prescriptions via `vw_prescription_details` |
| `GET` | `/api/staff/pharmacist/prescription-items/:prescriptionId` | `Admin`, `Pharmacist` | Lists prescription items with current stock from `vw_medicine_inventory` |
| `GET` | `/api/staff/pharmacist/inventory` | `Admin`, `Pharmacist` | Lists medicine inventory from `vw_medicine_inventory` (`?q=`) |
| `POST` | `/api/staff/pharmacist/dispense/:prescriptionId` | `Admin`, `Pharmacist` | Dispenses prescription using FEFO batch deduction (`MEDICINE_BATCH` -> `DISPENSING_RECORD`/`ITEM`) |
| `POST` | `/api/staff/receptionist/register-patient` | `Receptionist`, `Admin` | Creates `USER`, `PATIENT`, and `PATIENT_ALLERGY` rows in one transaction |
| `POST` | `/api/staff/receptionist/book-appointment` | `Receptionist`, `Admin` | Books appointment via `sp_book_appointment` |
| `POST` | `/api/staff/receptionist/generate-bill` | `Receptionist`, `Admin` | Generates invoice via `sp_generate_bill` |
| `GET` | `/api/staff/receptionist/appointments` | `Receptionist`, `Admin` | Lists appointments with consultation and bill context |
| `POST` | `/api/staff/receptionist/appointments/:id/cancel` | `Receptionist`, `Admin` | Cancels an active appointment inside a transaction, freeing the slot |
| `POST` | `/api/staff/receptionist/appointments/:id/reschedule` | `Receptionist`, `Admin` | Blocks `Completed` appointments, cancels old slot, and calls `sp_book_appointment` inside one transaction |
| `GET` | `/api/staff/pharmacist/notifications` | `Pharmacist`, `Admin` | Lists low-stock notifications for pharmacist |

### 8. Billing & Payments (`routes/billing.js` -> `/api/billing`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/billing` | `Admin`, `Receptionist`, `Doctor`, `Patient` | Lists bills scoped to the caller's role |
| `GET` | `/api/billing/:billId` | `Admin`, `Receptionist`, `Doctor`, `Patient` | Returns bill summary, `BILL_ITEM` list, and `PAYMENT` list (ownership verified) |
| `GET` | `/api/billing/:billId/items` | `Admin`, `Receptionist`, `Doctor`, `Patient` | Lists line items for a bill |
| `GET` | `/api/billing/:billId/payments` | `Admin`, `Receptionist`, `Doctor`, `Patient` | Lists recorded payments for a bill |
| `POST` | `/api/billing/:billId/payments` | `Admin`, `Receptionist` | Records a partial or full payment in `PAYMENT` with receipt `RCP-YYYY-XXXXX` |

### 9. User Profile (`routes/profile.js` -> `/api/profile`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/profile/change-password` | Any Authenticated User | Verifies current password and updates `USER.password_hash` |

### 10. Emergency Ward & Priority Engine (`routes/emergency.js` -> `/api/emergency`)
| Method | Endpoint | Allowed Roles | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/emergency/dashboard` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Returns real-time ER KPIs, acuity breakdown, bed and on-duty counts |
| `GET` | `/api/emergency/queue` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Returns active ER queue sorted by dynamic priority score and wait time |
| `POST` | `/api/emergency/register` | `Admin`, `Receptionist`, `Nurse` | Registers walk-in or ambulance ER case with `EMG-YYYY-XXX` number |
| `GET` | `/api/emergency/cases/:id` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Returns full ER case details, triage history, treatments, vitals, notes, and blood requests |
| `POST` | `/api/emergency/triage/:id` | `Admin`, `Doctor`, `Nurse` | Records `TRIAGE_ASSESSMENT`, logs priority change, updates `EMERGENCY_CASE` |
| `PATCH` | `/api/emergency/priority/:id` | `Admin`, `Doctor`, `Nurse` | Overrides `triage_priority` with mandatory reason in `EMERGENCY_PRIORITY_LOG` |
| `GET` | `/api/emergency/priority-engine/:id` | `Admin`, `Doctor`, `Nurse` | Evaluates case acuity, vitals, complaints, doctor shifts/workloads, and available beds |
| `POST` | `/api/emergency/allocate/:id` | `Admin`, `Doctor`, `Nurse` | Atomically allocates doctor and `Available` bed (`FOR UPDATE`) to an ER case |
| `POST` | `/api/emergency/treatment/:id` | `Admin`, `Doctor` | Logs clinical treatment action (enforcing assigned doctor ownership) |
| `POST` | `/api/emergency/admit/:id` | `Admin`, `Doctor` | Converts ER case to inpatient `ADMISSION` in target bed |
| `POST` | `/api/emergency/discharge/:id` | `Admin`, `Doctor` | Discharges ER case, posts emergency charge to `BILL_ITEM`, moves bed to `Cleaning` |
| `GET` | `/api/emergency/doctors` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Lists doctors with on-duty shift status and active ER caseload |
| `GET` | `/api/emergency/beds` | `Admin`, `Doctor`, `Nurse`, `Receptionist` | Lists beds prioritized for emergency allocation |
