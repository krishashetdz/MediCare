# Sequence Diagrams
## Critical Hospital Workflows

### 1. Normal Patient Outpatient Workflow
```mermaid
sequenceDiagram
    autonumber
    actor Patient
    actor Doctor
    actor Pharmacist
    participant System as Express Backend
    participant DB as MariaDB / MySQL
    participant Mongo as MongoDB

    Patient->>System: POST /api/patient/book-appointment
    System->>DB: CALL sp_book_appointment(...)
    DB-->>System: Appointment Scheduled
    System->>Mongo: Log audit_log event: appointment_booked
    System-->>Patient: 201 Created (Confirmed Slot)

    Doctor->>System: POST /api/doctor/consultations
    System->>DB: INSERT INTO CONSULTATION
    System->>DB: UPDATE APPOINTMENT SET status='Completed'
    System->>DB: INSERT INTO MEDICAL_RECORD (Auto-sync diagnosis)
    System->>Mongo: Log audit_log event: consultation_completed
    System-->>Doctor: 201 Created

    Doctor->>System: POST /api/doctor/prescriptions
    System->>DB: INSERT INTO PRESCRIPTION & ITEMS
    System-->>Doctor: Prescription Issued

    Pharmacist->>System: POST /api/staff/dispense
    System->>DB: BEGIN TRANSACTION
    System->>DB: SELECT stock_qty FROM MEDICINE FOR UPDATE
    System->>DB: UPDATE MEDICINE SET stock_qty = stock_qty - N
    System->>DB: COMMIT TRANSACTION
    System-->>Pharmacist: 200 Dispensed & Stock Deducted
```

---

### 2. Emergency Ward & Signature Priority Engine Workflow
```mermaid
sequenceDiagram
    autonumber
    actor Nurse
    actor Doctor
    participant System as Express Backend
    participant Engine as Priority Engine Service
    participant DB as MariaDB / MySQL
    participant Mongo as MongoDB

    Nurse->>System: POST /api/emergency/register (Priya Nair, Walk-in/Ambulance)
    System->>DB: INSERT INTO EMERGENCY_CASE (EMG-2026-006)
    System-->>Nurse: Emergency Case Created

    Nurse->>System: POST /api/emergency/triage/:id (BP: 160/100, SpO2: 91%, HR: 118, P1)
    System->>DB: INSERT INTO TRIAGE_ASSESSMENT
    System->>DB: UPDATE EMERGENCY_CASE SET priority='P1', status='Triaged'
    System->>DB: INSERT INTO EMERGENCY_PRIORITY_LOG
    System-->>Nurse: Triage Complete

    Nurse->>System: POST /api/emergency/priority-engine/:id
    System->>Engine: evaluateCase(case_id)
    Engine->>DB: Query case vitals, complaints & severity
    Engine->>DB: Query on-duty DOCTOR_SHIFT & current active caseload
    Engine->>DB: Query available BED in Emergency/ICU wards
    Engine-->>System: Recommendations (Dr. Bhosale [Cardiology], Bed E-05)
    System->>Mongo: Log audit_log: emergency_priority_engine_evaluated
    System-->>Nurse: 200 OK with Rationale & Recommendations

    Nurse->>System: POST /api/emergency/allocate/:id (Confirm Doctor & Bed)
    System->>DB: BEGIN TRANSACTION
    System->>DB: SELECT * FROM BED WHERE bed_id = ? FOR UPDATE
    System->>DB: UPDATE BED SET status='Occupied', patient_id = ?
    System->>DB: UPDATE EMERGENCY_CASE SET assigned_doctor_id=?, assigned_bed_id=?, status='In-Treatment'
    System->>DB: COMMIT TRANSACTION
    System-->>Nurse: Resource Allocation Confirmed

    Doctor->>System: POST /api/emergency/discharge/:id (Clinical Summary)
    System->>DB: BEGIN TRANSACTION
    System->>DB: UPDATE EMERGENCY_CASE SET status='Discharged', discharge_time=NOW()
    System->>DB: UPDATE BED SET status='Cleaning', patient_id=NULL
    System->>DB: COMMIT TRANSACTION
    System-->>Doctor: Case Discharged & Bed Sent to Cleaning
```

---

### 3. Blood Bank Lifecycle & Inventory Transfusion Workflow
```mermaid
sequenceDiagram
    autonumber
    actor Doctor
    actor Supervisor as Lab / Bank Supervisor
    participant System as Express Backend
    participant DB as MariaDB / MySQL
    participant Mongo as MongoDB

    Doctor->>System: POST /api/resources/blood-bank/request (Units: 2, Group: B+)
    System->>DB: INSERT INTO BLOOD_REQUEST (status='Pending')
    System-->>Doctor: 201 Blood Request Created (No stock deducted yet)

    Supervisor->>System: PUT /api/resources/blood-bank/approve/:id
    System->>DB: UPDATE BLOOD_REQUEST SET status='Approved'
    System-->>Supervisor: 200 Request Approved

    Supervisor->>System: PUT /api/resources/blood-bank/fulfill/:id
    System->>DB: BEGIN TRANSACTION
    System->>DB: SELECT units_available FROM BLOOD_INVENTORY WHERE blood_group='B+' FOR UPDATE
    System->>DB: UPDATE BLOOD_INVENTORY SET units_available = units_available - 2
    System->>DB: UPDATE BLOOD_REQUEST SET status='Fulfilled'
    System->>DB: COMMIT TRANSACTION
    System->>Mongo: Log audit_log: blood_request_fulfilled
    System-->>Supervisor: 200 Fulfilled & Inventory Deducted
```
