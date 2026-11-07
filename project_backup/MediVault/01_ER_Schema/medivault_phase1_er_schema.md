# MediVault — Phase 1: ER Diagram & Normalized Relational Schema Design (3NF)

## 1. Design Philosophy

MediVault uses a **single shared `USER` table** as the anchor for authentication and RBAC. Every human who logs in — patient, doctor, or staff member — has exactly one row in `USER`, and role-specific data lives in a satellite table (`PATIENT`, `DOCTOR`, `STAFF`) that shares the same primary key as `USER` (a **1:1 "is-a" relationship**, implemented as PK = FK).

All tables in the canonical schema (`db/schema.sql`) strictly satisfy **First Normal Form (1NF)**, **Second Normal Form (2NF)**, and **Third Normal Form (3NF)**:
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
