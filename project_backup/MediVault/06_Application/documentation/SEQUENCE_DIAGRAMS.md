# Sequence Diagrams
## End-to-End Transactional Hospital Workflows

### 1. Outpatient Booking, Rescheduling, Consultation, Lab, Dispensing & Split Payment
```mermaid
sequenceDiagram
    autonumber
    actor Patient
    actor Receptionist
    actor Doctor
    actor LabTech as Lab Technician
    actor Pharmacist
    participant API as Express Server
    participant MySQL as MariaDB / MySQL
    participant Mongo as MongoDB

    Patient->>API: POST /api/patient/book-appointment
    API->>MySQL: CALL sp_book_appointment(patient_id, doctor_id, dept_id, date, time, booked_by)
    MySQL-->>API: Appointment Scheduled (uq_doctor_active_slot enforced)
    API->>Mongo: insertOne(audit_log {user_id, action: 'BOOK appointment', table_affected: 'APPOINTMENT', details, timestamp})
    API-->>Patient: 201 Created

    Receptionist->>API: POST /api/staff/receptionist/appointments/:id/reschedule
    API->>MySQL: BEGIN; SELECT ... FOR UPDATE; UPDATE old status='Cancelled'; CALL sp_book_appointment(...); COMMIT
    API->>Mongo: insertOne(audit_log {user_id, action: 'RESCHEDULE appointment', ...})
    API-->>Receptionist: 201 Rescheduled (or 409 Conflict with full rollback if slot taken)

    Doctor->>API: PATCH /api/doctor/appointments/:id/status {status: 'Confirmed'}
    API->>MySQL: UPDATE APPOINTMENT SET status='Confirmed'
    API->>Mongo: insertOne(audit_log {user_id, action: 'CONFIRM appointment', ...})
    API-->>Doctor: 200 OK

    Doctor->>API: POST /api/doctor/consultations (with recommend_admission=true)
    API->>MySQL: INSERT CONSULTATION; UPDATE APPOINTMENT status='Completed'; INSERT MEDICAL_RECORD; INSERT ADMISSION_REQUEST
    API->>Mongo: insertOne(audit_log {user_id, action: 'COMPLETE consultation', ...})
    API-->>Doctor: 201 Created

    Doctor->>API: POST /api/doctor/prescriptions & POST /api/doctor/lab-requests
    API->>MySQL: INSERT PRESCRIPTION + PRESCRIPTION_ITEM; INSERT LAB_REQUEST
    API-->>Doctor: 201 Created

    LabTech->>API: POST /api/staff/lab-tech/requests/:id/report
    API->>MySQL: INSERT LAB_REPORT; UPDATE LAB_REQUEST status='Completed'
    API->>Mongo: updateOne(lab_reports_raw) & insertOne(audit_log {action: 'INSERT lab report'})
    API-->>LabTech: 201 Created

    Pharmacist->>API: POST /api/staff/pharmacist/dispense/:prescriptionId
    API->>MySQL: BEGIN; Lock MEDICINE_BATCH (FEFO); Deduct available_qty; INSERT DISPENSING_RECORD & DISPENSING_ITEM; UPDATE PRESCRIPTION status='Dispensed'; COMMIT
    API->>Mongo: insertOne(audit_log {action: 'DISPENSE prescription'})
    API-->>Pharmacist: 200 OK

    Receptionist->>API: POST /api/staff/receptionist/generate-bill
    API->>MySQL: CALL sp_generate_bill(appointment_id, user_id)
    MySQL-->>API: BILL + BILL_ITEM rows created
    API-->>Receptionist: 201 Created

    Receptionist->>API: POST /api/billing/:billId/payments (Partial then Final)
    API->>MySQL: INSERT INTO PAYMENT (receipt_number RCP-YYYY-XXXXX); query vw_bill_summary
    API->>Mongo: insertOne(audit_log {action: 'RECORD payment'})
    API-->>Receptionist: 201 Created (Partial -> Paid)
```

---

### 2. Emergency Dispatch, Triage, Priority Engine, Allocation & Discharge
```mermaid
sequenceDiagram
    autonumber
    actor AdminOrRec as Admin / Receptionist
    actor Nurse
    actor Doctor
    participant API as Express Server
    participant MySQL as MariaDB / MySQL
    participant Mongo as MongoDB

    AdminOrRec->>API: POST /api/admin/ambulance/:id/dispatch
    API->>MySQL: BEGIN; Lock AMBULANCE; Increment EMERGENCY_SEQUENCE; INSERT EMERGENCY_CASE; INSERT AMBULANCE_DISPATCH; COMMIT
    API->>Mongo: insertOne(ambulance_dispatch_log) & insertOne(audit_log {action: 'DISPATCH ambulance'})
    API-->>AdminOrRec: 200 OK (case_id, emg_number)

    Nurse->>API: POST /api/emergency/triage/:caseId
    API->>MySQL: BEGIN; INSERT TRIAGE_ASSESSMENT; INSERT EMERGENCY_PRIORITY_LOG; UPDATE EMERGENCY_CASE SET triage_priority, status='Triage'; COMMIT
    API-->>Nurse: 201 Created

    Nurse->>API: GET /api/emergency/priority-engine/:caseId
    API->>MySQL: Query EMERGENCY_CASE, TRIAGE_ASSESSMENT, on-duty DOCTOR_SHIFT (excluding DOCTOR_LEAVE), and Available BEDs
    API-->>Nurse: 200 OK (Recommended Department, Doctor & Bed with clinical rationale)

    Nurse->>API: POST /api/emergency/allocate/:caseId
    API->>MySQL: BEGIN; SELECT BED FOR UPDATE; Verify Available; INSERT EMERGENCY_DOCTOR_ASSIGNMENT & EMERGENCY_BED_ASSIGNMENT; UPDATE BED status='Occupied'; COMMIT
    API-->>Nurse: 200 OK

    Doctor->>API: POST /api/emergency/treatment/:caseId
    API->>MySQL: Verify doctor ownership; INSERT EMERGENCY_TREATMENT_LOG; UPDATE EMERGENCY_CASE status='In Treatment'
    API-->>Doctor: 201 Created

    Doctor->>API: POST /api/emergency/discharge/:caseId
    API->>MySQL: BEGIN; Deactivate assignments; UPDATE BED status='Cleaning'; UPDATE EMERGENCY_CASE status='Discharged'; Create BILL & Emergency BILL_ITEM; COMMIT
    API-->>Doctor: 200 OK
```
