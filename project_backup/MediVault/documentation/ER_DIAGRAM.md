# Entity-Relationship (ER) Diagram
## MediCare Database Architecture

The following Mermaid diagram represents the complete relational entity model of MediCare, including core hospital entities, the Emergency Ward, dynamic triage tracking, and resource inventory:

```mermaid
erDiagram
    USER ||--o| PATIENT : "identifies"
    USER ||--o| DOCTOR : "identifies"
    USER ||--o| STAFF : "identifies"
    DEPARTMENT ||--o{ DOCTOR : "employs"
    DEPARTMENT ||--o{ APPOINTMENT : "hosts"

    PATIENT ||--o{ APPOINTMENT : "books"
    DOCTOR ||--o{ APPOINTMENT : "conducts"
    APPOINTMENT ||--o| CONSULTATION : "results in"
    PATIENT ||--o{ MEDICAL_RECORD : "accumulates"
    DOCTOR ||--o{ MEDICAL_RECORD : "authors"

    CONSULTATION ||--o{ PRESCRIPTION : "generates"
    PRESCRIPTION ||--o{ PRESCRIPTION_ITEM : "contains"
    MEDICINE ||--o{ PRESCRIPTION_ITEM : "dispensed in"

    CONSULTATION ||--o{ LAB_REQUEST : "orders"
    LAB_TEST ||--o{ LAB_REQUEST : "specified by"
    LAB_REQUEST ||--o| LAB_REPORT : "fulfilled by"
    STAFF ||--o{ LAB_REPORT : "performed by"

    BED ||--o{ ADMISSION : "accommodates"
    PATIENT ||--o{ ADMISSION : "admitted in"
    DOCTOR ||--o{ ADMISSION : "supervises"

    PATIENT ||--o{ EMERGENCY_CASE : "presents as"
    DOCTOR ||--o{ EMERGENCY_CASE : "assigned to"
    BED ||--o{ EMERGENCY_CASE : "allocated to"
    AMBULANCE ||--o{ EMERGENCY_CASE : "transported by"

    EMERGENCY_CASE ||--o{ TRIAGE_ASSESSMENT : "triaged by"
    USER ||--o{ TRIAGE_ASSESSMENT : "recorded by"
    EMERGENCY_CASE ||--o{ EMERGENCY_PRIORITY_LOG : "audited by"
    EMERGENCY_CASE ||--o{ EMERGENCY_TREATMENT_LOG : "treated by"

    DOCTOR ||--o{ DOCTOR_SHIFT : "works"
    PATIENT ||--o{ PATIENT_VITALS : "measured for"
    STAFF ||--o{ PATIENT_VITALS : "recorded by"
    PATIENT ||--o{ NURSE_NOTE : "documented for"

    BLOOD_INVENTORY ||--o{ BLOOD_REQUEST : "supplies"
    PATIENT ||--o{ BLOOD_REQUEST : "transfused to"
    DOCTOR ||--o{ BLOOD_REQUEST : "prescribed by"
    EMERGENCY_CASE ||--o{ BLOOD_REQUEST : "linked to"

    PATIENT ||--o{ BILL : "billed to"
    BILL ||--o{ BILL_ITEM : "itemized into"
```

### Key Cardinalities & Constraints
- `USER` to `PATIENT`/`DOCTOR`/`STAFF`: 1-to-1 extension table inheritance.
- `APPOINTMENT` to `CONSULTATION`: 1-to-0..1 (only completed appointments yield clinical consultations).
- `EMERGENCY_CASE` to `TRIAGE_ASSESSMENT`: 1-to-Many (supports initial triage and subsequent clinical reassessments).
- `EMERGENCY_CASE` to `EMERGENCY_PRIORITY_LOG`: 1-to-Many (strict immutable audit trail for every priority escalation or override).
- `BED` to `EMERGENCY_CASE`: 1-to-0..1 active allocation enforced by row-level locking.
