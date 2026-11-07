# Data Flow Diagram (DFD) – Level 1
## Major Functional Subsystems & Data Stores

```mermaid
graph TD
    Actors(["Authenticated Users (Admin, Doctor, Nurse, Receptionist, Lab Tech, Pharmacist, Patient)"])

    subgraph Subsystems [MediVault Core Processes]
        P1["1.0 Auth, RBAC & Staff/Patient Onboarding"]
        P2["2.0 Outpatient Scheduling (Book, Reschedule, Cancel)"]
        P3["3.0 Clinical Consultation, EMR & Admission Requests"]
        P4["4.0 Diagnostic Lab Orders & Hybrid Reporting"]
        P5["5.0 Pharmacy FEFO Batch Dispensing"]
        P6["6.0 Emergency Ward, Triage & Priority Engine"]
        P7["7.0 Inpatient Ward, Bed Assignment & Discharge"]
        P8["8.0 Blood Bank Request, Approval & Fulfillment"]
        P9["9.0 Ambulance Dispatch & Release"]
        P10["10.0 Billing (`sp_generate_bill`) & Partial/Full Payments"]
    end

    subgraph DataStores [Relational (MySQL) & Document (MongoDB) Stores]
        D1[("D1: ROLE, USER, DOCTOR, PATIENT, PATIENT_ALLERGY, STAFF")]
        D2[("D2: APPOINTMENT, DOCTOR_SHIFT, DOCTOR_LEAVE")]
        D3[("D3: CONSULTATION, MEDICAL_RECORD, ADMISSION_REQUEST")]
        D4[("D4: LAB_TEST, LAB_REQUEST, LAB_REPORT + Mongo lab_reports_raw")]
        D5[("D5: MEDICINE, MEDICINE_BATCH, PRESCRIPTION, DISPENSING_RECORD/ITEM")]
        D6[("D6: EMERGENCY_CASE, TRIAGE_ASSESSMENT, EMERGENCY_DOCTOR/BED_ASSIGNMENT")]
        D7[("D7: WARD, BED, ADMISSION, PATIENT_VITALS, NURSE_NOTE")]
        D8[("D8: BLOOD_BANK, BLOOD_REQUEST")]
        D9[("D9: AMBULANCE, AMBULANCE_DISPATCH + Mongo ambulance_dispatch_log")]
        D10[("D10: BILL, BILL_ITEM, PAYMENT, vw_bill_summary")]
        D11[("D11: NOTIFICATION + Mongo notification_log & audit_log")]
    end

    Actors --> P1
    P1 <--> D1
    P1 -.-> D11

    Actors --> P2
    P2 <--> D2
    P2 -.-> D11

    Actors --> P3
    P3 <--> D3
    P3 --> P4
    P3 --> P5
    P3 --> P7
    P3 -.-> D11

    Actors --> P4
    P4 <--> D4
    P4 -.-> D11

    Actors --> P5
    P5 <--> D5
    P5 -.-> D11

    Actors --> P6
    P6 <--> D6
    P6 <--> D7
    P6 -.-> D11

    Actors --> P7
    P7 <--> D7
    P7 --> P10

    Actors --> P8
    P8 <--> D8
    P8 -.-> D11

    Actors --> P9
    P9 <--> D9
    P9 --> P6

    Actors --> P10
    P10 <--> D10
    P10 -.-> D11
```
