# MediCare – Smart Hospital & Emergency Management System

MediCare is an integrated, enterprise-grade Hospital and Emergency Management Platform. It connects general outpatient/inpatient workflows with a dedicated Emergency Ward powered by the **Signature Emergency Priority Engine**, dynamic priority queuing, concurrency-safe bed allocation, and dual-database persistence (MariaDB/MySQL + MongoDB).

---

## 🏥 Key Systems & Capabilities

1. **Emergency Ward & Priority Engine**:
   - Real-time emergency dashboard with active, critical, and bed KPIs.
   - Dynamic priority queue (P1 Critical, P2 High, P3 Moderate, P4 Low) scored by clinical acuity and waiting time.
   - **Signature Emergency Priority Engine**: Rule-based resource allocation evaluating patient vitals, complaints, doctor shift schedules, active workloads, and bed availability to yield actionable clinical recommendations.
   - Concurrency-safe bed and doctor allocation using `SELECT ... FOR UPDATE` database row-level locking.
   - Real-time clinical treatment logging and emergency outcome management (ICU/Ward admission or discharge).

2. **Inpatient & Bed Management**:
   - Ward occupancy map for Emergency, General, ICU, and Pediatric wards.
   - Atomic bed assignment, transfer, and automatic release to `'Cleaning'` status upon patient discharge.

3. **Blood Bank Transfusion Lifecycle**:
   - Real-time 8 blood group inventory gauges.
   - End-to-end request workflow: `Pending` ➔ `Approved` / `Rejected` ➔ `Fulfilled`.
   - Inventory units are deducted **only** upon actual fulfillment and issuance.

4. **Ambulance Fleet & Emergency Integration**:
   - Vehicle fleet tracking and driver assignment.
   - Persistent dispatch records linked to emergency cases with audit telematics logged to MongoDB.

5. **Nurse & Clinical Staff Workspace**:
   - Ward-wise assigned inpatient roster.
   - Routine vital sign recording and nursing care notes.
   - Live high-acuity emergency telemetry monitor.

6. **Outpatient, Diagnostics, Pharmacy & Billing**:
   - Patient registration, appointment scheduling with collision prevention (`sp_book_appointment`).
   - Doctor clinical consultations with automatic synchronization to unified patient `MEDICAL_RECORD`.
   - Diagnostic laboratory test orders with priority levels (`Normal`, `Urgent`, `Emergency`).
   - Pharmacy dispensing queue with automatic stock decrement.
   - Unified invoicing for room, consultations, medications, tests, and emergency services.

---

## 📚 Complete Project Documentation

All system documentation and architectural diagrams are located in the `documentation/` directory:

- [System Architecture](documentation/ARCHITECTURE.md)
- [Database Schema & Dictionary](documentation/DATABASE.md)
- [REST API Reference](documentation/API_DOCUMENTATION.md)
- [Entity-Relationship (ER) Diagram](documentation/ER_DIAGRAM.md)
- [Data Flow Diagram Level 0](documentation/DFD_LEVEL_0.md)
- [Data Flow Diagram Level 1](documentation/DFD_LEVEL_1.md)
- [Data Flow Diagram Level 2 (Emergency Subsystem)](documentation/DFD_LEVEL_2.md)
- [Use Case Diagram](documentation/USE_CASE_DIAGRAM.md)
- [Sequence Diagrams](documentation/SEQUENCE_DIAGRAMS.md)
- [Activity Diagrams](documentation/ACTIVITY_DIAGRAMS.md)
- [Component Diagram](documentation/COMPONENT_DIAGRAM.md)
- [Deployment Diagram](documentation/DEPLOYMENT_DIAGRAM.md)
- [Installation Guide](documentation/INSTALLATION.md)
- [User Roles & Access Control Matrix](documentation/USER_ROLES.md)
- [Testing & Verification Report (100% Pass)](documentation/TESTING_REPORT.md)
- [Implementation Status Report](documentation/IMPLEMENTATION_STATUS_REPORT.md)

---

## 🚀 Running the Project

```bash
# 1. Start MariaDB / MySQL on port 3306
# 2. Run migrations
mysql -u root medivault < migrations/emergency_schema.sql
mysql -u root medivault < migrations/emergency_seed.sql

# 3. Start Node.js application
cd project_backup/MediVault/06_Application
node server.js

# 4. Open browser
http://localhost:3000
```
