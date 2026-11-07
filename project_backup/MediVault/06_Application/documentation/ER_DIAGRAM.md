# Entity-Relationship (ER) Diagram
## MediVault / MediCare 3NF Relational Schema

```mermaid
erDiagram
    ROLE ||--o{ USER : "assigns"
    USER ||--o| PATIENT : "extends"
    USER ||--o| DOCTOR : "extends"
    USER ||--o| STAFF : "extends"

    DEPARTMENT ||--o{ DOCTOR : "employs"
    DOCTOR ||--o| DEPARTMENT : "heads (hod_doctor_id)"
    DEPARTMENT ||--o{ STAFF : "assigns"

    DOCTOR ||--o{ DOCTOR_SHIFT : "works"
    DOCTOR ||--o{ DOCTOR_LEAVE : "requests"

    PATIENT ||--o{ PATIENT_ALLERGY : "has (1NF)"
    PATIENT ||--o{ APPOINTMENT : "books"
    DOCTOR ||--o{ APPOINTMENT : "conducts"
    APPOINTMENT ||--o| CONSULTATION : "yields"
    PATIENT ||--o{ MEDICAL_RECORD : "accumulates"
    DOCTOR ||--o{ MEDICAL_RECORD : "authors"

    CONSULTATION ||--o{ PRESCRIPTION : "generates"
    PRESCRIPTION ||--o{ PRESCRIPTION_ITEM : "contains"
    MEDICINE ||--o{ PRESCRIPTION_ITEM : "specified in"
    MEDICINE ||--o{ MEDICINE_BATCH : "stocked in (FEFO)"
    PRESCRIPTION ||--o| DISPENSING_RECORD : "fulfilled by"
    DISPENSING_RECORD ||--o{ DISPENSING_ITEM : "deducts"
    MEDICINE_BATCH ||--o{ DISPENSING_ITEM : "supplies"

    CONSULTATION ||--o{ LAB_REQUEST : "orders"
    LAB_TEST ||--o{ LAB_REQUEST : "defines"
    LAB_REQUEST ||--o| LAB_REPORT : "completed by"
    STAFF ||--o{ LAB_REPORT : "authored by"

    WARD ||--o{ BED : "contains"
    CONSULTATION ||--o{ ADMISSION_REQUEST : "recommends"
    WARD ||--o{ ADMISSION_REQUEST : "targeted by"
    ADMISSION_REQUEST ||--o| ADMISSION : "fulfilled by"
    BED ||--o{ ADMISSION : "hosts"
    PATIENT ||--o{ ADMISSION : "admitted in"

    PATIENT ||--o{ EMERGENCY_CASE : "presents in"
    AMBULANCE ||--o{ EMERGENCY_CASE : "transports"
    DEPARTMENT ||--o{ EMERGENCY_CASE : "routed to"
    EMERGENCY_CASE ||--o{ EMERGENCY_DOCTOR_ASSIGNMENT : "assigned to"
    DOCTOR ||--o{ EMERGENCY_DOCTOR_ASSIGNMENT : "attends"
    EMERGENCY_CASE ||--o{ EMERGENCY_BED_ASSIGNMENT : "occupies"
    BED ||--o{ EMERGENCY_BED_ASSIGNMENT : "allocated to"
    AMBULANCE ||--o{ AMBULANCE_DISPATCH : "dispatched in"
    EMERGENCY_CASE ||--o{ AMBULANCE_DISPATCH : "linked to"

    EMERGENCY_CASE ||--o{ TRIAGE_ASSESSMENT : "assessed in"
    EMERGENCY_CASE ||--o{ EMERGENCY_PRIORITY_LOG : "audited in"
    EMERGENCY_CASE ||--o{ EMERGENCY_TREATMENT_LOG : "treated in"

    PATIENT ||--o{ BLOOD_REQUEST : "receives"
    EMERGENCY_CASE ||--o{ BLOOD_REQUEST : "requests"
    PATIENT ||--o{ PATIENT_VITALS : "monitored via"
    PATIENT ||--o{ NURSE_NOTE : "documented in"

    PATIENT ||--o{ BILL : "invoiced via"
    APPOINTMENT ||--o{ BILL : "billed for"
    ADMISSION ||--o{ BILL : "billed for"
    EMERGENCY_CASE ||--o{ BILL : "billed for"
    BILL ||--o{ BILL_ITEM : "itemized in"
    BILL ||--o{ PAYMENT : "settled via"

    USER ||--o{ NOTIFICATION : "receives"
    USER ||--o{ AUDIT_LOG : "logged in"
```

### Key Normalization & Integrity Highlights
- **Single-Column Surrogate/Subtype Keys**: All 34 base tables use single-column primary keys (`2NF` by construction).
- **3NF Derivation Chains**:
  - `APPOINTMENT.doctor_id -> DOCTOR.department_id -> DEPARTMENT`
  - `PRESCRIPTION.consultation_id -> CONSULTATION.appointment_id -> APPOINTMENT.(patient_id, doctor_id)`
  - `BED.ward_id -> WARD.(ward_name, floor_no, daily_rate)`
  - `BILL -> BILL_ITEM` and `BILL -> PAYMENT` (summarized via `vw_bill_summary`).
