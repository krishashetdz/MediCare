   # MediVault — Phase 1: ER Diagram & Relational Schema Design

## 1. Design Philosophy

MediVault uses a **single shared USER table** as the anchor for authentication and RBAC. Every human who logs in — patient, doctor, or staff member — has exactly one row in `USER`, and role-specific data lives in a satellite table (`PATIENT`, `DOCTOR`, `STAFF`) that shares the same primary key as `USER` (a **1:1 "is-a" relationship**, implemented as PK = FK). This is the standard pattern for role-based systems: it keeps login/auth logic in one place, avoids duplicating name/email/password across tables, and lets you add a new role type later without touching the login flow.

---

## 2. Entities & Attributes

Legend: 🔑 PK · 🔗 FK · ⭐ UNIQUE · ✅ NOT NULL

### Identity & Access Cluster

**ROLE**
| Attribute | Notes |
|---|---|
| 🔑 role_id | INT AUTO_INCREMENT |
| role_name ✅⭐ | Admin / Doctor / Patient / Nurse / Lab Technician / Pharmacist / Receptionist |

**USER**
| Attribute | Notes |
|---|---|
| 🔑 user_id | INT AUTO_INCREMENT |
| name ✅ | |
| email ✅⭐ | login identifier |
| password_hash ✅ | never store plaintext |
| phone | |
| 🔗 role_id ✅ | → ROLE |
| is_active | boolean, for soft-disable |
| created_at | DEFAULT CURRENT_TIMESTAMP |

**PATIENT** (extends USER)
| Attribute | Notes |
|---|---|
| 🔑🔗 patient_id | = user_id → USER |
| dob | |
| gender ✅ | CHECK IN ('M','F','Other') |
| blood_group | |
| address | |
| emergency_contact | |

**DOCTOR** (extends USER)
| Attribute | Notes |
|---|---|
| 🔑🔗 doctor_id | = user_id → USER |
| 🔗 department_id ✅ | → DEPARTMENT |
| specialization | |
| qualification | |
| consultation_fee | DECIMAL(8,2) |
| experience_years | |

**DEPARTMENT**
| Attribute | Notes |
|---|---|
| 🔑 department_id | |
| department_name ✅⭐ | Cardiology, Orthopedics, etc. |
| floor_no | |
| 🔗 hod_doctor_id | → DOCTOR, nullable (chicken-and-egg with DOCTOR — resolved with `ON DELETE SET NULL` and deferred insert order) |

**STAFF** (extends USER)
| Attribute | Notes |
|---|---|
| 🔑🔗 staff_id | = user_id → USER |
| staff_type ✅ | ENUM/CHECK: NURSE, LAB_TECHNICIAN, PHARMACIST, RECEPTIONIST |
| 🔗 department_id | → DEPARTMENT, nullable |
| shift | Morning/Evening/Night |

### Clinical Cluster

**APPOINTMENT**
| Attribute | Notes |
|---|---|
| 🔑 appointment_id | |
| 🔗 patient_id ✅ | → PATIENT |
| 🔗 doctor_id ✅ | → DOCTOR |
| 🔗 department_id ✅ | → DEPARTMENT (denormalized copy avoided — derivable via doctor, kept out to satisfy 3NF, see §4) |
| appointment_date ✅ | |
| appointment_time ✅ | |
| status ✅ | CHECK IN ('Scheduled','Completed','Cancelled') |
| 🔗 booked_by | → USER (self-booked or receptionist) |
| created_at | |

**MEDICAL_RECORD**
| Attribute | Notes |
|---|---|
| 🔑 record_id | |
| 🔗 patient_id ✅ | → PATIENT |
| 🔗 doctor_id ✅ | → DOCTOR |
| diagnosis_summary | |
| created_at | |

**CONSULTATION**
| Attribute | Notes |
|---|---|
| 🔑 consultation_id | |
| 🔗 appointment_id ✅⭐ | → APPOINTMENT (1:1 — one consultation per appointment) |
| symptoms | |
| diagnosis | |
| notes | |
| consultation_date | |

### Pharmacy Cluster

**PRESCRIPTION**
| Attribute | Notes |
|---|---|
| 🔑 prescription_id | |
| 🔗 consultation_id ✅ | → CONSULTATION |
| 🔗 patient_id ✅ | → PATIENT |
| 🔗 doctor_id ✅ | → DOCTOR |
| prescribed_date | |
| status ✅ | CHECK IN ('Pending','Dispensed') |

**PRESCRIPTION_ITEM**
| Attribute | Notes |
|---|---|
| 🔑 item_id | |
| 🔗 prescription_id ✅ | → PRESCRIPTION |
| 🔗 medicine_id ✅ | → MEDICINE |
| dosage | e.g. "1-0-1" |
| duration_days | |
| quantity ✅ | CHECK > 0 |

**MEDICINE**
| Attribute | Notes |
|---|---|
| 🔑 medicine_id | |
| medicine_name ✅ | |
| manufacturer | |
| unit_price ✅ | DECIMAL(8,2) |
| stock_qty ✅ | CHECK >= 0, DEFAULT 0 |
| expiry_date | |

### Lab Cluster

**LAB_TEST**
| Attribute | Notes |
|---|---|
| 🔑 test_id | |
| test_name ✅⭐ | |
| test_category | Pathology/Radiology/etc. |
| price ✅ | |

**LAB_REQUEST**
| Attribute | Notes |
|---|---|
| 🔑 request_id | |
| 🔗 consultation_id ✅ | → CONSULTATION |
| 🔗 test_id ✅ | → LAB_TEST |
| 🔗 requested_by ✅ | → DOCTOR |
| status ✅ | CHECK IN ('Pending','Completed') |
| request_date | |

**LAB_REPORT**
| Attribute | Notes |
|---|---|
| 🔑 report_id | |
| 🔗 request_id ✅⭐ | → LAB_REQUEST (1:1) |
| 🔗 technician_id ✅ | → STAFF |
| result_summary | short relational summary; full structured result deferred to MongoDB `lab_reports_raw` in Phase 5 |
| report_date | |

### Facilities & Ops Cluster

**BED**
| Attribute | Notes |
|---|---|
| 🔑 bed_id | |
| ward_name ✅ | |
| bed_number ✅ | |
| status ✅ | CHECK IN ('Available','Occupied') |
| 🔗 patient_id | → PATIENT, nullable (null = unoccupied) |

**AMBULANCE**
| Attribute | Notes |
|---|---|
| 🔑 ambulance_id | |
| vehicle_number ✅⭐ | |
| driver_name | |
| driver_phone | |
| status ✅ | CHECK IN ('Available','On Duty') |

**BLOOD_BANK**
| Attribute | Notes |
|---|---|
| 🔑 blood_id | |
| blood_group ✅⭐ | A+, A-, B+, ... |
| units_available ✅ | CHECK >= 0 |
| last_updated | |

### Billing Cluster

**BILL**
| Attribute | Notes |
|---|---|
| 🔑 bill_id | |
| 🔗 patient_id ✅ | → PATIENT |
| 🔗 appointment_id | → APPOINTMENT, nullable |
| total_amount ✅ | DECIMAL(10,2), maintained by trigger (Phase 4) |
| payment_status ✅ | CHECK IN ('Paid','Unpaid','Partial') |
| bill_date | |
| 🔗 generated_by | → USER |

**BILL_ITEM**
| Attribute | Notes |
|---|---|
| 🔑 bill_item_id | |
| 🔗 bill_id ✅ | → BILL |
| item_type ✅ | CHECK IN ('Consultation','Lab','Medicine','Bed') |
| description | |
| amount ✅ | |

### Cross-Cutting (also modeled in MongoDB later — Phase 5)

**NOTIFICATION** — kept relationally for Phase 1–4 demos, mirrored into MongoDB in Phase 5 for the hybrid architecture.
| Attribute | Notes |
|---|---|
| 🔑 notification_id | |
| 🔗 user_id ✅ | → USER |
| message ✅ | |
| is_read | DEFAULT FALSE |
| created_at | |

**AUDIT_LOG** — same note as above.
| Attribute | Notes |
|---|---|
| 🔑 log_id | |
| 🔗 user_id | → USER |
| action ✅ | e.g. "UPDATE stock_qty" |
| table_affected ✅ | |
| timestamp | |

---

## 3. Relationships & Cardinality Summary

| Relationship | Cardinality |
|---|---|
| ROLE — USER | 1 : N |
| USER — PATIENT / DOCTOR / STAFF | 1 : 1 (subtype) |
| DEPARTMENT — DOCTOR | 1 : N |
| DEPARTMENT — STAFF | 1 : N |
| DOCTOR — DEPARTMENT (as HOD) | 1 : 1, optional |
| PATIENT — APPOINTMENT | 1 : N |
| DOCTOR — APPOINTMENT | 1 : N |
| APPOINTMENT — CONSULTATION | 1 : 1 |
| PATIENT / DOCTOR — MEDICAL_RECORD | 1 : N each |
| CONSULTATION — PRESCRIPTION | 1 : 1 (a consult yields at most one prescription) |
| PRESCRIPTION — PRESCRIPTION_ITEM | 1 : N |
| MEDICINE — PRESCRIPTION_ITEM | 1 : N |
| CONSULTATION — LAB_REQUEST | 1 : N |
| LAB_TEST — LAB_REQUEST | 1 : N |
| LAB_REQUEST — LAB_REPORT | 1 : 1 |
| STAFF (technician) — LAB_REPORT | 1 : N |
| BED — PATIENT | 1 : 1, optional (null when free) |
| PATIENT — BILL | 1 : N |
| BILL — BILL_ITEM | 1 : N |
| USER — NOTIFICATION | 1 : N |
| USER — AUDIT_LOG | 1 : N |
| AMBULANCE, BLOOD_BANK | standalone ops tables, referenced by admin/receptionist workflows — no FK into the clinical chain in this version |

---

## 4. ASCII ER Diagram (by cluster)

```
IDENTITY & ACCESS
─────────────────
   ROLE(1)───<(N)USER(1)───(1)PATIENT
                 │(1)
                 ├──(1)DOCTOR(N)───>(1)DEPARTMENT
                 │(1)
                 └──(1)STAFF(N)───>(1)DEPARTMENT [optional]

   DEPARTMENT(1)───(0..1)DOCTOR   [hod_doctor_id, nullable FK]

CLINICAL FLOW
─────────────
   PATIENT(1)───<(N)APPOINTMENT(N)>───(1)DOCTOR
                       │(1)
                       └──(1)CONSULTATION
                               │(1)
                    ┌──────────┼──────────┐
                    │(N)                  │(N)
              PRESCRIPTION            LAB_REQUEST(N)>──(1)LAB_TEST
                    │(1)                   │(1)
                    │(N)                   └──(1)LAB_REPORT>──(1)STAFF(tech)
              PRESCRIPTION_ITEM(N)>──(1)MEDICINE

BILLING & FACILITIES
─────────────────────
   PATIENT(1)───<(N)BILL(1)───<(N)BILL_ITEM
   PATIENT(0..1)───(1)BED   [nullable — one active bed or none]
   AMBULANCE, BLOOD_BANK    [standalone; admin/receptionist managed]

CROSS-CUTTING
─────────────
   USER(1)───<(N)NOTIFICATION
   USER(1)───<(N)AUDIT_LOG
```

---

## 5. Normalization: 1NF → 2NF → 3NF

**Starting point (unnormalized idea):** a naive design might store a patient's prescribed medicines as a single comma-separated column on `PRESCRIPTION` (e.g. `medicines = "Paracetamol, Amoxicillin"`), and might store `department_name` directly on `APPOINTMENT` for convenience.

**1NF — atomic values, no repeating groups.**
The comma-separated medicines column violates 1NF (a cell holding a multi-valued list). Fix: split into `PRESCRIPTION_ITEM`, one row per medicine per prescription. Every remaining table already has atomic, single-valued attributes — 1NF is satisfied.

**2NF — no partial dependency on a composite key.**
2NF only matters where a table has a composite primary key. Suppose `PRESCRIPTION_ITEM` used `(prescription_id, medicine_id)` as a composite PK. `dosage` and `quantity` depend on the *combination* (fine), but a hypothetical `medicine_name` column stored there would depend only on `medicine_id` — a **partial dependency**, violating 2NF. Fix: `medicine_name` lives only in `MEDICINE`; `PRESCRIPTION_ITEM` references it by `medicine_id` and uses its own single-column surrogate key `item_id`, sidestepping the composite-key issue entirely while keeping the dependency clean.

**3NF — no transitive dependency between non-key attributes.**
Storing `department_name` on `APPOINTMENT` is a transitive dependency: `appointment_id → doctor_id → department_id → department_name`. `department_name` depends on `department_id`, not directly on `appointment_id`. Fix: `APPOINTMENT` stores only `department_id` (or nothing at all, since it's derivable through `doctor_id` — kept as an FK here purely for query convenience and enforced consistency, not as duplicated data, since it references `DEPARTMENT` directly rather than storing the name). Similarly, `BILL.total_amount` is the one deliberate, documented exception: it's a **derived value maintained by a trigger** (Phase 4) rather than computed at query time, a common and defensible denormalization for performance in billing systems — called out explicitly rather than left as an accidental redundancy.

All 21 tables above are designed to satisfy 3NF except that one documented, trigger-maintained exception.

---

**Next:** say "next phase" for Phase 2 — DDL (with constraints) and DML sample data for all 21 tables.
