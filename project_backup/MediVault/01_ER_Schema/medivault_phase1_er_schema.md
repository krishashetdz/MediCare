# MediVault — Phase 1: ER Diagram & Normalized Relational Schema Design (3NF)

## 1. Design Philosophy

MediVault uses a **single shared `USER` table** as the anchor for authentication and RBAC. Every human who logs in — patient, doctor, or staff member — has exactly one row in `USER`, and role-specific data lives in a satellite table (`PATIENT`, `DOCTOR`, `STAFF`) that shares the same primary key as `USER` (a **1:1 "is-a" relationship**, implemented as PK = FK).

All core tables in the canonical schema (`db/schema.sql`) strictly satisfy **First Normal Form (1NF)**, **Second Normal Form (2NF)**, and **Third Normal Form (3NF)**:
- Multi-valued attributes (`PATIENT.allergies`) are extracted into atomic child tables (`PATIENT_ALLERGY`).
- Multi-batch stock attributes (`MEDICINE.stock_qty`, `MEDICINE.expiry_date`) are normalized into `MEDICINE_BATCH` with transactional batch deductions tracked in `DISPENSING_RECORD` and `DISPENSING_ITEM`.
- Transitive foreign keys and lookup strings (`APPOINTMENT.department_id`, `PRESCRIPTION.patient_id`, `PRESCRIPTION.doctor_id`, `BED.ward_name`, `ADMISSION.ward_name`) are eliminated from base tables and derived via joins or views (`WARD`, `vw_bed_details`, `vw_prescription_details`).
- Stored derived billing totals and statuses (`BILL.total_amount`, `BILL.payment_status`) are replaced by a normalized `PAYMENT` table and computed dynamically via `vw_bill_summary`.
- Overwritten emergency assignment columns (`EMERGENCY_CASE.assigned_doctor_id`, `EMERGENCY_CASE.assigned_bed_id`) and dual bed-occupancy pointers (`BED.patient_id`) are replaced by assignment history tables (`EMERGENCY_DOCTOR_ASSIGNMENT`, `EMERGENCY_BED_ASSIGNMENT`) and `ADMISSION`, with current occupancy derived via `vw_bed_details`.

## 2. Normalization Audit Table (1NF / 2NF / 3NF Violations & Fixes)

| Table / Attribute | Violation | Problem Description | Canonical Fix in `db/schema.sql` |
|---|---|---|---|
| `PATIENT.allergies` | 1NF | Comma-separated allergy list stored in a single column | Extracted into `PATIENT_ALLERGY (allergy_id, patient_id, allergy_name, severity, noted_at)` with `UNIQUE(patient_id, allergy_name)`. |
| `MEDICINE.stock_qty`, `MEDICINE.expiry_date` | 1NF / 2NF / 3NF | Multiple stock batches with distinct expiry dates collapsed onto the catalog row | Extracted into `MEDICINE_BATCH (batch_id, medicine_id, batch_number, expiry_date, available_qty)` and `DISPENSING_RECORD` / `DISPENSING_ITEM`. Aggregated via `vw_medicine_inventory`. |
| `APPOINTMENT.department_id` | 3NF | Transitive dependency: `appointment_id -> doctor_id -> department_id` | Removed `department_id` from `APPOINTMENT`; derived by joining `DOCTOR` and `DEPARTMENT`. |
| `PRESCRIPTION.patient_id`, `PRESCRIPTION.doctor_id` | 3NF | Transitive dependency: `prescription_id -> consultation_id -> appointment_id -> (patient_id, doctor_id)` | Removed `patient_id` and `doctor_id` from `PRESCRIPTION`; derived via `CONSULTATION -> APPOINTMENT` (`vw_prescription_details`). |
| `BED.ward_name` | 3NF | Repeating ward metadata across bed rows | Created `WARD (ward_id, ward_name, floor_no, ward_type, daily_rate)` and replaced `BED.ward_name` with `BED.ward_id`. |
| `ADMISSION.ward_name` | 3NF | Transitive dependency: `admission_id -> bed_id -> ward_id -> ward_name` | Removed `ward_name` from `ADMISSION`; derived via `BED -> WARD`. |
| `BILL.total_amount`, `BILL.payment_status` | 3NF | Stored derived values dependent on `BILL_ITEM` and payments | Removed from `BILL`; created `PAYMENT` table and computed `total_amount`, `paid_amount`, `balance_due`, and `payment_status` in `vw_bill_summary`. |
| `EMERGENCY_CASE.assigned_doctor_id`, `EMERGENCY_CASE.assigned_bed_id` | 1NF / 3NF | Overwriting columns loses assignment history and duplicates bed state | Created `EMERGENCY_DOCTOR_ASSIGNMENT` and `EMERGENCY_BED_ASSIGNMENT` history tables with `is_active` flags. |
| `BED.patient_id` | 3NF | Duplicate occupancy state alongside `ADMISSION` and `EMERGENCY_BED_ASSIGNMENT` | Removed `patient_id` from `BED`; current occupant derived via `vw_bed_details`. |

## 3. Initial (Pre-3NF) vs. Final (3NF) Schema Comparison

| Entity / Area | Initial Unnormalized / Pre-3NF Design | Final Normalized 3NF Design (`db/schema.sql`) |
|---|---|---|
| **Patient Allergies** | `PATIENT(patient_id, dob, gender, blood_group, allergies, address, emergency_contact)` | `PATIENT(patient_id, dob, gender, blood_group, address, emergency_contact)` + `PATIENT_ALLERGY(allergy_id, patient_id, allergy_name, severity, noted_at)` |
| **Pharmacy Stock** | `MEDICINE(medicine_id, medicine_name, manufacturer, unit_price, stock_qty, expiry_date)` | `MEDICINE(medicine_id, medicine_name, manufacturer, unit_price)` + `MEDICINE_BATCH(batch_id, medicine_id, batch_number, expiry_date, available_qty, received_at)` + `vw_medicine_inventory` |
| **Appointments** | `APPOINTMENT(appointment_id, patient_id, doctor_id, department_id, appointment_date, appointment_time, status)` | `APPOINTMENT(appointment_id, patient_id, doctor_id, appointment_date, appointment_time, status, booked_by)` (department derived via `DOCTOR.department_id`) |
| **Prescriptions** | `PRESCRIPTION(prescription_id, consultation_id, patient_id, doctor_id, prescribed_date, status)` | `PRESCRIPTION(prescription_id, consultation_id, prescribed_date, status)` + `vw_prescription_details` |
| **Wards, Beds & Admissions** | `BED(bed_id, ward_name, bed_number, status, patient_id)` + `ADMISSION(admission_id, patient_id, bed_id, ward_name, admitted_at, status)` | `WARD(ward_id, ward_name, floor_no, ward_type, daily_rate)` + `BED(bed_id, ward_id, bed_number, status)` + `ADMISSION(admission_id, patient_id, bed_id, ...)` + `vw_bed_details` |
| **Billing & Payments** | `BILL(bill_id, patient_id, appointment_id, total_amount, payment_status, bill_date)` | `BILL(bill_id, patient_id, appointment_id, admission_id, case_id, bill_date, generated_by)` + `BILL_ITEM(...)` + `PAYMENT(...)` + `vw_bill_summary` |
| **Emergency Assignments** | `EMERGENCY_CASE(case_id, ..., assigned_doctor_id, assigned_bed_id)` | `EMERGENCY_CASE(case_id, ...)` + `EMERGENCY_DOCTOR_ASSIGNMENT(...)` + `EMERGENCY_BED_ASSIGNMENT(...)` |

## 4. Justification: Why Initial Tables Were Not in 3NF (and Controlled Final-Schema Exceptions)

### A. Why the Initial Schema Violated 1NF, 2NF, and 3NF
1. **1NF Violation (Non-Atomic / Multi-Valued Columns)**: Storing `'Penicillin, Dust Mites'` in `PATIENT.allergies` prevented indexed allergy lookups and caused update anomalies when adding/removing a single allergy.
2. **2NF / Batch Granularity Violation**: Storing `stock_qty` and `expiry_date` directly in `MEDICINE` meant batch-specific attributes did not depend solely on `medicine_id`; two batches of Metformin with different expiry dates could not coexist without duplicating the medicine row.
3. **3NF Violations (Transitive Dependencies & Derived Columns)**:
   - `appointment_id -> doctor_id -> department_id`: If a doctor transferred departments, historical `APPOINTMENT.department_id` values became inconsistent.
   - `prescription_id -> consultation_id -> appointment_id -> (patient_id, doctor_id)`: Redundant foreign keys risked pointing a prescription to a different patient/doctor than its consultation.
   - `admission_id -> bed_id -> ward_id -> ward_name`: Renaming a ward required updating every bed and admission row (update anomaly).
   - `BILL.total_amount` and `BILL.payment_status` depended transitively on `SUM(BILL_ITEM.amount)` and `SUM(PAYMENT.amount_paid)`, risking stale balances if a line item or partial payment changed.

### B. Pragmatic / Controlled Non-3NF Exceptions in the Final Operational Schema
Where strict BCNF/3NF decomposition would hurt clinical safety or real-time emergency triage, three deliberate, transaction-guarded columns are retained:
1. **`EMERGENCY_CASE.triage_priority` (Cached Latest Priority)**: Full triage history lives in `TRIAGE_ASSESSMENT` and `EMERGENCY_PRIORITY_LOG`, but caching the latest priority directly on `EMERGENCY_CASE` enables indexed `P1 -> P4` emergency queue sorting without expensive correlated subqueries on every dashboard poll.
2. **`BED.status` (`Available` / `Occupied` / `Cleaning` / `Reserved` / `Maintenance`)**: Occupancy is tracked in `ADMISSION` and `EMERGENCY_BED_ASSIGNMENT`, while `BED.status` is retained to enforce the hospital infection-control state machine (`Occupied -> Cleaning -> Available`) and block allocation of beds undergoing sanitization or maintenance.
3. **`AMBULANCE_DISPATCH.patient_name` & `contact_phone` (Point-in-Time Snapshot)**: Captured at ambulance dispatch before an unidentified emergency patient is registered in `USER`/`PATIENT`, preserving an immutable historical dispatch record even if patient contact details change later.
