# Database Documentation
## MediCare / MediVault Database Specification

### 1. Relational Schema (MySQL / MariaDB)
The relational database `medivault` contains 25 tables, views, and stored routines.

#### Core Tables
1. **`USER`**: Core identity table storing encrypted credentials, roles (`Admin`, `Doctor`, `Nurse`, `Patient`, `Staff`, `Receptionist`), phone, email, and timestamps.
2. **`PATIENT`**: Patient demographics, emergency contacts, blood groups (`A+`, `A-`, `B+`, `B-`, `AB+`, `AB-`, `O+`, `O-`), known allergies, and chronic medical history.
3. **`DOCTOR`**: Doctor specialization, license numbers, room assignments, consultation fees, and department affiliations.
4. **`DEPARTMENT`**: Clinical departments (Cardiology, Emergency Medicine, General Medicine, Orthopedics, Pediatrics, Neurology, ENT, Dermatology).
5. **`STAFF`**: Non-physician personnel assignments including nursing supervisors, lab technicians, and pharmacists.
6. **`APPOINTMENT`**: Scheduled consultations. Check constraint: `status IN ('Scheduled', 'Confirmed', 'Completed', 'Cancelled')`.
7. **`CONSULTATION`**: Clinical encounter details including recorded symptoms, diagnosis, physician notes, and encounter date.
8. **`MEDICAL_RECORD`**: Unified clinical record linking patients with attending doctors and diagnosis summaries.
9. **`BED`**: Hospital bed inventory. Columns: `bed_id`, `ward_name`, `bed_number`, `status` (`'Available', 'Occupied', 'Cleaning', 'Maintenance', 'Emergency'`), `patient_id`.
10. **`ADMISSION`**: Inpatient admissions linking patients to beds, admitting doctors, admission date, discharge date, and status.

#### Emergency Ward Tables
11. **`EMERGENCY_CASE`**: Primary emergency encounter tracking.
    - `case_id` (INT PK AUTO_INCREMENT)
    - `case_number` (VARCHAR(30) UNIQUE, e.g. `EMG-2026-001`)
    - `patient_id` (INT NULL FK -> `PATIENT.patient_id`)
    - `temp_name` (VARCHAR(150), for unidentified/unconscious arrivals)
    - `age`, `gender`, `contact_phone`, `emergency_contact`
    - `arrival_mode` (`'Ambulance', 'Walk-in', 'Transfer', 'Police'`)
    - `ambulance_id` (INT NULL FK -> `AMBULANCE.ambulance_id`)
    - `initial_complaint` (TEXT)
    - `priority` (`'P1', 'P2', 'P3', 'P4'`)
    - `status` (`'Registered', 'Triaged', 'In-Treatment', 'Admitted', 'Transferred', 'Discharged', 'Deceased'`)
    - `assigned_doctor_id` (INT NULL FK -> `DOCTOR.doctor_id`)
    - `assigned_bed_id` (INT NULL FK -> `BED.bed_id`)
    - `arrival_time`, `triage_time`, `discharge_time`
12. **`TRIAGE_ASSESSMENT`**: Clinical triage records.
    - `assessment_id` (INT PK AUTO_INCREMENT)
    - `case_id` (INT FK -> `EMERGENCY_CASE.case_id`)
    - `systolic_bp`, `diastolic_bp`, `heart_rate`, `oxygen_saturation`, `temperature`, `respiratory_rate`
    - `consciousness_level` (`'Alert', 'Voice', 'Pain', 'Unresponsive'`)
    - `symptoms`, `injury_details`, `priority`, `assessed_by` (INT FK -> `USER.user_id`), `assessed_at`
13. **`EMERGENCY_PRIORITY_LOG`**: Immutable audit log of priority changes and overrides.
    - `log_id` (INT PK AUTO_INCREMENT)
    - `case_id` (INT FK -> `EMERGENCY_CASE.case_id`)
    - `previous_priority`, `new_priority`, `change_reason`, `changed_by` (INT FK -> `USER.user_id`), `changed_at`
14. **`EMERGENCY_TREATMENT_LOG`**: Real-time physician clinical actions, medication administered, and procedural notes.

#### Doctor Shift & Nursing Tables
15. **`DOCTOR_SHIFT`**: Active shift tracking (`'Morning', 'Evening', 'Night', 'On-Call'`) with shift date and active boolean flag.
16. **`DOCTOR_LEAVE`**: Doctor leave requests, coverage, and approval tracking.
17. **`PATIENT_VITALS`**: Ongoing routine vital signs logged by ward nurses.
18. **`NURSE_NOTE`**: Nursing care observations, patient responses, and shift handover notes.

#### Diagnostics, Pharmacy, Billing & Resources
19. **`LAB_TEST`**: Laboratory test catalogue and pricing.
20. **`LAB_REQUEST`**: Diagnostic orders. Columns include `priority` (`'Normal', 'Urgent', 'Emergency'`).
21. **`LAB_REPORT`**: Completed test summaries, technician IDs, and reference timestamps.
22. **`MEDICINE`**: Drug formulary, unit price, stock quantity, expiry dates, and minimum reorder thresholds.
23. **`PRESCRIPTION` & `PRESCRIPTION_ITEM`**: Physician prescriptions linked to appointments and emergency encounters.
24. **`BILL` & `BILL_ITEM`**: Comprehensive hospital invoicing. `BILL_ITEM.item_type` includes `'Emergency'`.
25. **`BLOOD_INVENTORY` & `BLOOD_REQUEST`**: Blood bank lifecycle tracking with units requested, approved, and issued.
26. **`AMBULANCE`**: Vehicle registry, status (`'Available', 'On Duty', 'Maintenance'`), and assigned drivers.

---

### 2. MongoDB Collections
1. **`audit_log`**:
   ```json
   {
     "event": "consultation_completed | emergency_priority_engine_evaluated | blood_request_fulfilled",
     "user_id": 1,
     "timestamp": "2026-10-30T19:00:00Z",
     "metadata": { ... }
   }
   ```
2. **`lab_reports_raw`**:
   Flexible polymorphic diagnostic test profiles (e.g. Complete Blood Count differentials, Liver Function Panels).
3. **`ambulance_dispatch_log`**:
   Telemetry, route coordinates, dispatch and arrival timestamps linked to `EMERGENCY_CASE`.
