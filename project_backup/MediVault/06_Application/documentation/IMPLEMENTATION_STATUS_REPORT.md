# Implementation Status Report
## Honest Feature & Verification Audit

Columns follow the strict four-state classification:
- **Works and Tested**: Implemented and covered by automated assertions in `test-e2e.js`.
- **Works but Untested**: Implemented in backend routes/SQL and UI, verified by static/code inspection, but not directly asserted by an automated test in `test-e2e.js` (or requires live DB runtime outside this sandbox).
- **Partial**: Implemented with known scope limitations.
- **Not Implemented**: Out of scope / not built.

| Subsystem / Feature | Works and Tested | Works but Untested | Partial | Not Implemented | Notes & Verification Coverage |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Bcrypt Auth & Legacy Fallback Rejection** | Yes (`test-e2e.js` §1) | - | - | - | Rejects wrong password, legacy `'password'`, `'admin123'`, `'hash_admin1'`; logs in all 7 roles |
| **Role-Based Access Control (RBAC 401/403)** | Yes (`test-e2e.js` §1, §2, §5, §7) | - | - | - | Verifies unauthenticated 401, cross-role 403s, and cross-doctor ownership 403s |
| **MySQL DATE Timezone Serialization (`dateStrings: ['DATE']`)** | Yes (`test-e2e.js` §2) | - | - | - | Configured in `config/db.js`; local date parsing in `mv-core.js` |
| **Patient Registration & 1NF Allergies (`PATIENT_ALLERGY`)** | Yes (`test-e2e.js` §2) | - | - | - | `POST /api/staff/receptionist/register-patient` |
| **Appointment Booking (`sp_book_appointment`) & 409 Slot Collision** | Yes (`test-e2e.js` §2) | - | - | - | Unique active slot enforced via `uq_doctor_active_slot` |
| **Receptionist Appointment Reschedule & Cancel** | Yes (`test-e2e.js` §2b) | - | - | - | Reschedule to free slot (201), taken slot (409 + rollback), block `Completed` (409), cancel frees slot (200) |
| **Doctor Consultation, EMR Sync & `ADMISSION_REQUEST`** | Yes (`test-e2e.js` §2) | - | - | - | `POST /api/doctor/consultations` |
| **3NF Prescription & Instructions** | Yes (`test-e2e.js` §2) | - | - | - | `POST /api/doctor/prescriptions` |
| **Lab Request & Hybrid Report Upload (`LAB_REPORT` + `lab_reports_raw`)** | Yes (`test-e2e.js` §2) | Live Mongo persistence unverified in sandbox VM | - | - | Route writes to MySQL + Mongo `lab_reports_raw` |
| **Invoice Generation (`sp_generate_bill`) & Split Payments (`PAYMENT`)** | Yes (`test-e2e.js` §2) | - | - | - | Partial payment (`Partial`) + balance payment (`Paid`) with `RCP-` receipts |
| **Pharmacy FEFO Batch Dispensing & Expiry/Stock Guard** | Yes (`test-e2e.js` §3) | - | - | - | Deducts earliest non-expired `MEDICINE_BATCH`, rejects duplicate (409) and insufficient stock (409) |
| **Nurse Admission Bed Assignment, Discharge & Bed Turnover** | Yes (`test-e2e.js` §4) | - | - | - | Blocks occupied bed (409), assigns available bed, discharges to `Cleaning`, marks `Available` |
| **Ambulance Dispatch (`AMBULANCE_DISPATCH`) & Release** | Yes (`test-e2e.js` §5, §6) | - | - | - | Creates linked `EMERGENCY_CASE` and `AMBULANCE_DISPATCH` |
| **Emergency Triage, Priority Engine & Transactional Allocation** | Yes (`test-e2e.js` §5) | - | - | - | Recommends Cardiology doctor & bed; blocks duplicate bed allocation (409) |
| **Blood Bank Request, Approval Gate & Stock Fulfillment** | Yes (`test-e2e.js` §6) | - | - | - | Blocks unapproved fulfillment (409); deducts stock on approved fulfillment |
| **Admin Staff Creation (`POST /api/admin/staff`)** | Yes (`test-e2e.js` §7) | - | - | - | Creates `USER` + `STAFF` in one transaction, 409 on duplicate email, 403 for non-admin |
| **Nurse Vitals, Care Notes & Bed Transfer Endpoints** | - | Yes (`routes/staff.js`) | - | - | Implemented in `routes/staff.js` and `staff-portal.html`; not called in `test-e2e.js` |
| **Admin Doctor Creation, Shift Management & Analytics Charts** | - | Yes (`routes/admin.js`) | - | - | Implemented in `routes/admin.js` and `admin-*.html`; not called in `test-e2e.js` |
| **Profile Password Change (`POST /api/profile/change-password`)** | - | Yes (`routes/profile.js`) | - | - | Implemented in `routes/profile.js` and `profile.html`; not called in `test-e2e.js` |
| **External SMS / Email Gateway Delivery** | - | - | - | Yes | Notifications are stored in-app (`NOTIFICATION` + `notification_log`), not sent via external SMS/SMTP |
