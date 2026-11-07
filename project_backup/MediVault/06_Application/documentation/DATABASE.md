# Database Documentation
## MediVault / MediCare Normalized Database Specification (3NF + MongoDB)

### 1. Normalization & Deliberate Architectural Decisions

1. **Single-Column Primary Keys (2NF by Construction) & Full 3NF Compliance**:
   - Every base table in `db/schema.sql` uses a single-column primary key (`INT AUTO_INCREMENT PRIMARY KEY` or `INT PRIMARY KEY` for 1-to-1 subtype tables `DOCTOR`, `PATIENT`, `STAFF`, and `EMERGENCY_SEQUENCE`). Because no table uses a composite primary key, **Second Normal Form (2NF) holds by construction** (no non-key attribute can have a partial dependency on part of a candidate key).
   - Multi-valued attributes are decomposed into dedicated 1NF tables (`PATIENT_ALLERGY`), batch-specific medicine inventory is normalized into `MEDICINE_BATCH` (FEFO), dispensing transactions are normalized into `DISPENSING_RECORD` and `DISPENSING_ITEM`, ward attributes (`ward_name`, `floor_no`) are normalized into `WARD`, and partial/full invoice receipts are normalized into `PAYMENT`.
   - Transitive dependencies are removed across all tables (**3NF**): `APPOINTMENT` does not store `department_id` (derived via `doctor_id -> DOCTOR.department_id`); `PRESCRIPTION` does not store `patient_id` or `doctor_id` (derived via `consultation_id -> CONSULTATION -> APPOINTMENT`); `BILL` does not store `total_amount` or `payment_status` (computed dynamically from `BILL_ITEM` and `PAYMENT` via `vw_bill_summary`).
2. **Deliberate Current-State Denormalization (`EMERGENCY_CASE.triage_priority`)**:
   - `EMERGENCY_CASE.triage_priority` (`'P1'`, `'P2'`, `'P3'`, `'P4'`) is a deliberate current-state denormalization kept on `EMERGENCY_CASE` so the Emergency Priority Queue (`idx_emg_priority`) can sort and filter active high-acuity cases in constant time without scanning historical triage logs. Full immutable history is preserved in `TRIAGE_ASSESSMENT` (clinical vitals & assessment per triage event) and `EMERGENCY_PRIORITY_LOG` (audit trail of every priority change, user, timestamp, and reason).
3. **Role Consolidation (Why Billing Staff and Emergency Staff Are Not Separate Roles)**:
   - In hospital operations of this scale, **Receptionist** handles front-desk registration, appointment scheduling/rescheduling/cancellation, emergency walk-in/ambulance intake, invoice generation (`sp_generate_bill`), and payment collection (`PAYMENT`). **Nurse** handles clinical triage (`TRIAGE_ASSESSMENT`), emergency priority engine execution, bed allocation, inpatient admission requests, vitals, and nursing care notes. Avoiding separate `Billing Staff` and `Emergency Staff` roles eliminates artificial role-switching friction while maintaining strict separation between clinical actions (`Doctor`, `Nurse`), diagnostic/dispensing actions (`Lab Technician`, `Pharmacist`), and administrative/front-desk actions (`Receptionist`, `Admin`).

---

### 2. Relational Schema (`db/schema.sql` — 34 Base Tables + 11 Views = 45 Relations)

#### Cluster 1: Identity, Role & Access Control (9 Base Tables)
1. **`ROLE`**: `role_id` (PK), `role_name` (`Admin`, `Doctor`, `Patient`, `Nurse`, `Lab Technician`, `Pharmacist`, `Receptionist`).
2. **`USER`**: `user_id` (PK), `name`, `email` (UNIQUE), `password_hash` (bcrypt), `phone`, `role_id` (FK -> `ROLE`), `is_active`, `created_at`.
3. **`DEPARTMENT`**: `department_id` (PK), `department_name` (UNIQUE), `floor_no`, `hod_doctor_id` (FK -> `DOCTOR.doctor_id`).
4. **`DOCTOR`**: `doctor_id` (PK, FK -> `USER.user_id`), `department_id` (FK -> `DEPARTMENT`), `specialization`, `qualification`, `consultation_fee`.
5. **`DOCTOR_SHIFT`**: `shift_id` (PK), `doctor_id` (FK -> `DOCTOR`), `shift_date` (DATE), `shift_type` (`Morning`, `Evening`, `Night`), `start_time`, `end_time`, `is_on_duty`.
6. **`DOCTOR_LEAVE`**: `leave_id` (PK), `doctor_id` (FK -> `DOCTOR`), `start_date` (DATE), `end_date` (DATE), `reason`, `status` (`Pending`, `Approved`, `Rejected`), `approved_by` (FK -> `USER`).
7. **`PATIENT`**: `patient_id` (PK, FK -> `USER.user_id`), `dob` (DATE), `gender` (`M`, `F`, `O`), `blood_group` (`A+`, `A-`, `B+`, `B-`, `AB+`, `AB-`, `O+`, `O-`), `address`, `emergency_contact`.
8. **`PATIENT_ALLERGY`**: `allergy_id` (PK), `patient_id` (FK -> `PATIENT`), `allergy_name`, `severity` (`Mild`, `Moderate`, `Severe`), `noted_at`. Unique `(patient_id, allergy_name)`.
9. **`STAFF`**: `staff_id` (PK, FK -> `USER.user_id`), `staff_type` (`NURSE`, `LAB_TECHNICIAN`, `PHARMACIST`, `RECEPTIONIST`), `department_id` (FK -> `DEPARTMENT`), `shift` (`Morning`, `Evening`, `Night`).

#### Cluster 2: Outpatient & Clinical Records (3 Base Tables)
10. **`APPOINTMENT`**: `appointment_id` (PK), `patient_id` (FK -> `PATIENT`), `doctor_id` (FK -> `DOCTOR`), `appointment_date` (DATE), `appointment_time` (TIME), `status` (`Scheduled`, `Confirmed`, `Checked In`, `Completed`, `Cancelled`), `active_slot_date` (GENERATED VIRTUAL DATE — non-null only when active), `booked_by` (FK -> `USER`), `created_at`. Unique `(doctor_id, active_slot_date, appointment_time)`.
11. **`MEDICAL_RECORD`**: `record_id` (PK), `patient_id` (FK -> `PATIENT`), `doctor_id` (FK -> `DOCTOR`), `diagnosis_summary`, `created_at`.
12. **`CONSULTATION`**: `consultation_id` (PK), `appointment_id` (UNIQUE FK -> `APPOINTMENT`), `symptoms`, `diagnosis`, `notes`, `consultation_date`.

#### Cluster 3: Pharmacy & Batch Dispensing (6 Base Tables)
13. **`MEDICINE`**: `medicine_id` (PK), `medicine_name` (UNIQUE), `manufacturer`, `unit_price`.
14. **`MEDICINE_BATCH`**: `batch_id` (PK), `medicine_id` (FK -> `MEDICINE`), `batch_number`, `expiry_date` (DATE), `available_qty`, `received_at`. Unique `(medicine_id, batch_number)`.
15. **`PRESCRIPTION`**: `prescription_id` (PK), `consultation_id` (FK -> `CONSULTATION`), `prescribed_date`, `status` (`Pending`, `Dispensed`).
16. **`PRESCRIPTION_ITEM`**: `item_id` (PK), `prescription_id` (FK -> `PRESCRIPTION`), `medicine_id` (FK -> `MEDICINE`), `dosage`, `instructions`, `duration_days`, `quantity`.
17. **`DISPENSING_RECORD`**: `dispensing_id` (PK), `prescription_id` (UNIQUE FK -> `PRESCRIPTION`), `pharmacist_id` (FK -> `USER`), `dispensed_at`, `notes`.
18. **`DISPENSING_ITEM`**: `dispensing_item_id` (PK), `dispensing_id` (FK -> `DISPENSING_RECORD`), `prescription_item_id` (FK -> `PRESCRIPTION_ITEM`), `batch_id` (FK -> `MEDICINE_BATCH`), `quantity_dispensed`.

#### Cluster 4: Diagnostics & Laboratory (3 Base Tables)
19. **`LAB_TEST`**: `test_id` (PK), `test_name` (UNIQUE), `standard_cost`.
20. **`LAB_REQUEST`**: `request_id` (PK), `consultation_id` (FK -> `CONSULTATION`), `test_id` (FK -> `LAB_TEST`), `requested_by` (FK -> `DOCTOR`), `priority` (`Normal`, `Urgent`, `Emergency`), `status` (`Pending`, `Completed`), `request_date`.
21. **`LAB_REPORT`**: `report_id` (PK), `request_id` (UNIQUE FK -> `LAB_REQUEST`), `technician_id` (FK -> `STAFF`), `result_summary`, `report_date`.

#### Cluster 5: Wards, Beds, Emergency, Blood Bank & Inpatient Care (17 Base Tables)
22. **`WARD`**: `ward_id` (PK), `ward_name` (UNIQUE), `floor_no`, `daily_rate`.
23. **`BED`**: `bed_id` (PK), `ward_id` (FK -> `WARD`), `bed_number`, `status` (`Available`, `Occupied`, `Cleaning`, `Maintenance`). Unique `(ward_id, bed_number)`.
24. **`AMBULANCE`**: `ambulance_id` (PK), `vehicle_number` (UNIQUE), `driver_name`, `driver_phone`, `ambulance_type` (`Basic`, `Advanced`, `Cardiac`, `Neonatal`), `status` (`Available`, `On Duty`, `Maintenance`).
25. **`BLOOD_BANK`**: `blood_id` (PK), `blood_group` (UNIQUE), `units_available`, `last_updated`.
26. **`EMERGENCY_SEQUENCE`**: `seq_year` (PK), `last_val` (concurrency-safe sequence counter for `EMG-YYYY-XXX`).
27. **`EMERGENCY_CASE`**: `case_id` (PK), `emg_number` (UNIQUE), `patient_id` (FK -> `PATIENT`), `temp_patient_name`, `temp_patient_gender`, `temp_patient_age`, `contact_phone`, `emergency_contact`, `arrival_time`, `arrival_method`, `ambulance_id` (FK -> `AMBULANCE`), `initial_complaint`, `triage_priority` (`P1`, `P2`, `P3`, `P4`), `status` (`Waiting`, `Triage`, `Assigned`, `In Treatment`, `Admitted`, `Discharged`, `Transferred`), `department_id` (FK -> `DEPARTMENT`), `treatment_notes`, `discharge_summary`, `discharged_at`, `created_at`, `updated_at`.
28. **`EMERGENCY_DOCTOR_ASSIGNMENT`**: `assignment_id` (PK), `case_id` (FK -> `EMERGENCY_CASE`), `doctor_id` (FK -> `DOCTOR`), `assigned_by` (FK -> `USER`), `override_reason`, `assigned_at`, `unassigned_at`, `is_active`.
29. **`EMERGENCY_BED_ASSIGNMENT`**: `assignment_id` (PK), `case_id` (FK -> `EMERGENCY_CASE`), `bed_id` (FK -> `BED`), `assigned_by` (FK -> `USER`), `assigned_at`, `released_at`, `is_active`.
30. **`AMBULANCE_DISPATCH`**: `dispatch_id` (PK), `ambulance_id` (FK -> `AMBULANCE`), `case_id` (FK -> `EMERGENCY_CASE`), `patient_name`, `pickup_location`, `destination`, `contact_phone`, `dispatched_by` (FK -> `USER`), `dispatched_at`, `completed_at`, `status` (`In Transit`, `Completed`, `Cancelled`).
31. **`TRIAGE_ASSESSMENT`**: `triage_id` (PK), `case_id` (FK -> `EMERGENCY_CASE`), `nurse_id` (FK -> `USER`), `bp_systolic`, `bp_diastolic`, `heart_rate`, `spo2`, `temperature`, `respiratory_rate`, `consciousness_level` (`Alert`, `Verbal`, `Pain`, `Unresponsive`), `gcs_score`, `priority` (`P1`, `P2`, `P3`, `P4`), `priority_reason`, `symptoms`, `injury_details`, `assessment_notes`, `assessed_at`.
32. **`EMERGENCY_PRIORITY_LOG`**: `log_id` (PK), `case_id` (FK -> `EMERGENCY_CASE`), `old_priority`, `new_priority`, `changed_by` (FK -> `USER`), `reason`, `changed_at`.
33. **`EMERGENCY_TREATMENT_LOG`**: `treatment_id` (PK), `case_id` (FK -> `EMERGENCY_CASE`), `doctor_id` (FK -> `USER`), `action_type`, `description`, `performed_at`.
34. **`BLOOD_REQUEST`**: `request_id` (PK), `patient_id` (FK -> `PATIENT`), `case_id` (FK -> `EMERGENCY_CASE`), `requested_by` (FK -> `USER`), `blood_group`, `units`, `priority` (`Normal`, `Urgent`, `Emergency`), `reason`, `status` (`Pending`, `Approved`, `Rejected`, `Fulfilled`), `approved_by` (FK -> `USER`), `fulfilled_at`, `created_at`.
35. **`PATIENT_VITALS`**: `vital_id` (PK), `patient_id` (FK -> `PATIENT`), `case_id` (FK -> `EMERGENCY_CASE`), `recorded_by` (FK -> `USER`), `bp_systolic`, `bp_diastolic`, `heart_rate`, `spo2`, `temperature`, `respiratory_rate`, `notes`, `recorded_at`.
36. **`NURSE_NOTE`**: `note_id` (PK), `patient_id` (FK -> `PATIENT`), `case_id` (FK -> `EMERGENCY_CASE`), `bed_id` (FK -> `BED`), `nurse_id` (FK -> `USER`), `note_type`, `content`, `created_at`.
37. **`ADMISSION_REQUEST`**: `request_id` (PK), `patient_id` (FK -> `PATIENT`), `doctor_id` (FK -> `DOCTOR`), `consultation_id` (FK -> `CONSULTATION`), `appointment_id` (FK -> `APPOINTMENT`), `recommended_ward_id` (FK -> `WARD`), `priority` (`Standard`, `Urgent`, `Critical`), `reason`, `status` (`Pending`, `Assigned`, `Cancelled`), `assigned_bed_id` (FK -> `BED`), `assigned_by` (FK -> `USER`), `created_at`, `assigned_at`.
38. **`ADMISSION`**: `admission_id` (PK), `patient_id` (FK -> `PATIENT`), `case_id` (FK -> `EMERGENCY_CASE`), `request_id` (FK -> `ADMISSION_REQUEST`), `admitting_doctor_id` (FK -> `USER`), `bed_id` (FK -> `BED`), `admitted_at`, `discharged_at`, `discharge_summary`, `status` (`Admitted`, `Discharged`, `Transferred`).

#### Cluster 6: Billing & Payments (3 Base Tables)
39. **`BILL`**: `bill_id` (PK), `patient_id` (FK -> `PATIENT`), `appointment_id` (FK -> `APPOINTMENT`), `admission_id` (FK -> `ADMISSION`), `case_id` (FK -> `EMERGENCY_CASE`), `bill_date`, `generated_by` (FK -> `USER`).
40. **`BILL_ITEM`**: `item_id` (PK), `bill_id` (FK -> `BILL`), `description`, `amount`, `item_type` (`Consultation`, `Medicine`, `Lab`, `Room`, `Emergency`, `Admission`, `Other`).
41. **`PAYMENT`**: `payment_id` (PK), `bill_id` (FK -> `BILL`), `amount_paid`, `payment_method` (`Cash`, `Card`, `UPI`, `Bank Transfer`, `Insurance`), `reference_no`, `receipt_number` (UNIQUE), `paid_at`, `received_by` (FK -> `USER`).

#### Cluster 7: Notifications & Relational Audit Log (2 Base Tables)
42. **`NOTIFICATION`**: `notification_id` (PK), `user_id` (FK -> `USER`), `message`, `is_read`, `created_at`.
43. **`AUDIT_LOG`**: `log_id` (PK), `user_id` (FK -> `USER`), `action`, `table_affected`, `timestamp`.

#### Cluster 8: Normalized & Dashboard Views (11 Views)
1. **`vw_medicine_inventory`**: Aggregates non-expired `MEDICINE_BATCH` stock (`stock_qty`) and earliest non-expired `expiry_date` per medicine.
2. **`vw_bill_summary`**: Computes `total_amount` (from `BILL_ITEM`), `paid_amount` (from `PAYMENT`), `balance_due`, and `payment_status` (`Paid`, `Partial`, `Unpaid`) per bill.
3. **`vw_bed_details`**: Joins `BED` and `WARD` with active `ADMISSION` or active `EMERGENCY_BED_ASSIGNMENT` to resolve current `patient_id` and `case_id`.
4. **`vw_prescription_details`**: Derives `patient_id` and `doctor_id` for `PRESCRIPTION` via `CONSULTATION -> APPOINTMENT`.
5. **`vw_patient_allergies`**: Aggregates atomic `PATIENT_ALLERGY` rows into a comma-separated summary string per patient.
6. **`vw_doctor_today_schedule`**: Today's appointments joined with doctor, department, and patient details.
7. **`vw_patient_portal_summary`**: Per-patient KPIs (`next_appointment_date`, `record_count`, `pending_bills`, `unread_notifications`).
8. **`vw_pharmacy_low_stock`**: Medicines in `vw_medicine_inventory` with `stock_qty < 20`.
9. **`vw_monthly_revenue`**: Monthly sum of `total_amount` and `bill_count` from `vw_bill_summary`.
10. **`vw_bed_occupancy`**: Ward-level bed totals, occupied counts, and available counts.
11. **`vw_reception_dashboard`**: Snapshot counts for today's appointments, available beds, pending bills, and total registered patients.

#### Cluster 9: Triggers (4) & Stored Procedures (2)
- **`trg_update_stock`**: `BEFORE UPDATE ON PRESCRIPTION` — enforces FEFO batch stock deduction when `status` transitions to `'Dispensed'` if not already recorded in `DISPENSING_RECORD`.
- **`trg_low_stock_alert`**: `AFTER UPDATE ON MEDICINE_BATCH` — inserts `NOTIFICATION` rows for Admins and Pharmacists when non-expired stock drops below 20.
- **`trg_appointment_notification`**: `AFTER INSERT ON APPOINTMENT` — notifies both patient and doctor of the scheduled slot.
- **`trg_block_patient_delete`**: `BEFORE DELETE ON PATIENT` — blocks deletion if the patient has unpaid or partially paid bills in `vw_bill_summary`.
- **`sp_book_appointment`**: Locks the `DOCTOR` row (`FOR UPDATE`), verifies no active appointment occupies `(doctor_id, appointment_date, appointment_time)`, and inserts the `APPOINTMENT` row.
- **`sp_generate_bill`**: Creates `BILL` and itemized `BILL_ITEM` rows (consultation fee, prescribed medicines, lab tests, and room charges) inside a transaction.

---

### 3. MongoDB Collections (`medivault` database)

1. **`lab_reports_raw`**:
   Stores structured diagnostic parameters, reference ranges, findings, and optional imaging metadata uploaded by Lab Technicians (`POST /api/staff/lab-tech/requests/:id/report`).
2. **`audit_log`**:
   Consistent shape across all route writers:
   ```json
   {
     "user_id": 14,
     "action": "RESCHEDULE appointment",
     "table_affected": "APPOINTMENT",
     "details": { ... },
     "timestamp": "2026-11-07T16:30:00.000Z"
   }
   ```
3. **`ambulance_dispatch_log`**:
   Stores dispatch telemetry (`dispatch_id`, `ambulance_id`, `case_id`, `emg_number`, `vehicle_number`, `driver_name`, `patient_name`, `pickup_location`, `destination`, `contact_phone`, `dispatched_by`, `dispatched_at`, `completed_at`, `status`).
4. **`notification_log`**:
   Stores broadcast and user notification events written by `services/notificationService.js`.
