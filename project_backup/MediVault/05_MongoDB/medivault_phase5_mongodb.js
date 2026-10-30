// ============================================================
// MediVault -- Phase 5: MongoDB Hybrid Module (Experiment 9)
// Core/extended separation follows the supplied Experiment 9 CRUD mapping:
// insert, find, update and delete are core; nested shapes, projections,
// sort/limit and retention examples provide additional depth.
// ============================================================

// ------------------------------------------------------------
// WHY MONGODB ALONGSIDE MYSQL? (hybrid architecture rationale)
// ------------------------------------------------------------
// MySQL stays the system of record for anything with a fixed shape and
// referential integrity needs: PATIENT, DOCTOR, APPOINTMENT, BILL, etc.
// Those tables have a small, stable set of columns and MUST enforce FK
// constraints (a bill without a valid patient is a data-integrity bug).
//
// Two things in MediVault don't fit that mould, so they move to MongoDB:
//
//   1. audit_log -- write-heavy, append-only, never joined,
//      plus its "details" payload differs by action type (an appointment
//      audit entry and a stock-update audit entry naturally carry different
//      extra fields) -- forcing one rigid table schema for both means
//      either a wide table full of NULLs or a brittle key-value shim.
//
//   2. lab_reports_raw -- the strongest case. A CBC report has ~10 named
//      numeric parameters with reference ranges. An X-Ray report has a
//      findings paragraph and an image reference. A Thyroid Profile has
//      yet another parameter set. Modelling this relationally means either
//      a EAV (entity-attribute-value) table -- notoriously painful to
//      query -- or a separate table per test type. MongoDB just lets each
//      report document carry the fields that test type actually needs,
//      and dot-notation queries (see below) still let you search across
//      documents with different shapes.
//
// LAB_REPORT.result_summary (MySQL) keeps one line of human-readable text
// for the relational reports/queries in Phases 3-4. The FULL structured
// result lives here, cross-referenced by request_id.
//
// NOTIFICATION moved to MySQL (Phase A fix): trg_appointment_notification
// and trg_low_stock_alert already write there, FK enforces user_id integrity,
// volume is low. MongoDB reserved for audit_log + lab_reports_raw only.

use medivault

// ============================================================
// COLLECTION 1: audit_log
// ============================================================

// Core operations (syllabus ask)

// insertMany -- each entry's "details" payload naturally differs by action type
db.audit_log.insertMany([
    {
        user_id: 14, action: "INSERT appointment", table_affected: "APPOINTMENT",
        details: { appointment_id: 11, patient_id: 8 },
        timestamp: ISODate("2026-09-16T09:00:00Z")
    },
    {
        user_id: 2, action: "UPDATE prescription status to Dispensed", table_affected: "PRESCRIPTION",
        details: { prescription_id: 2 },
        timestamp: ISODate("2026-09-16T09:05:00Z")
    },
    {
        user_id: 12, action: "INSERT lab report", table_affected: "LAB_REPORT",
        details: { request_id: 1 },
        timestamp: ISODate("2026-09-15T18:00:00Z")
    }
]);

// find -- every audit entry touching a given table
db.audit_log.find({ table_affected: "APPOINTMENT" });

// Extended operations (added depth)
// find with sort + limit -- most recent 2 actions (admin activity feed)
db.audit_log.find().sort({ timestamp: -1 }).limit(2);

// find with a nested-field filter -- every action on a specific prescription
db.audit_log.find({ "details.prescription_id": 2 });

// deleteMany -- retention policy: drop audit entries older than 1 year
db.audit_log.deleteMany({ timestamp: { $lt: ISODate("2025-09-16T00:00:00Z") } });

// ============================================================
// COLLECTION 2: lab_reports_raw (flexible shape per test type)
// ============================================================

// Core operations (syllabus ask)

// insertOne -- CBC: a list of named numeric parameters with reference ranges
db.lab_reports_raw.insertOne({
    request_id: 1, patient_id: 5, test_name: "Lipid Profile", technician_id: 12,
    report_date: ISODate("2026-09-10T16:00:00Z"),
    parameters: [
        { name: "LDL", value: 145, unit: "mg/dL", flag: "High", reference_range: "<130" },
        { name: "HDL", value: 42, unit: "mg/dL", flag: "Normal", reference_range: ">40" },
        { name: "Triglycerides", value: 160, unit: "mg/dL", flag: "Normal", reference_range: "<150" }
    ]
});

// insertOne -- X-Ray: a completely different shape (narrative + image ref, no parameters array)
db.lab_reports_raw.insertOne({
    request_id: 2, patient_id: 6, test_name: "X-Ray Chest", technician_id: 12,
    report_date: ISODate("2026-09-10T17:00:00Z"),
    findings: "No fracture-related soft tissue abnormality seen",
    image_ref: "medivault-scans/xray_req2.png"
});

// insertOne -- CBC for a different patient, again its own parameter set
db.lab_reports_raw.insertOne({
    request_id: 3, patient_id: 7, test_name: "CBC", technician_id: 12,
    report_date: ISODate("2026-09-11T12:00:00Z"),
    parameters: [
        { name: "WBC", value: 11200, unit: "/uL", flag: "High", reference_range: "4000-11000" },
        { name: "Hemoglobin", value: 13.5, unit: "g/dL", flag: "Normal", reference_range: "13-17" }
    ]
});

// Extended operations (added depth)
// find with dot-notation into a nested array -- every abnormal result, across
// test types that don't even share a schema (this is the query a rigid SQL
// table would need a UNION-across-N-tables to answer)
db.lab_reports_raw.find(
    { "parameters.flag": "High" },
    { _id: 0, test_name: 1, patient_id: 1 }
);

// updateOne with $push -- lab re-runs one extra parameter on an existing report
db.lab_reports_raw.updateOne(
    { request_id: 1 },
    { $push: { parameters: { name: "VLDL", value: 32, unit: "mg/dL", flag: "Normal", reference_range: "5-40" } } }
);

// Core operations (syllabus ask)
// updateMany -- flag every report from a technician as reviewed by the lab head
db.lab_reports_raw.updateMany(
    { technician_id: 12 },
    { $set: { reviewed: true } }
);

// deleteOne -- retract a single erroneously-entered report
db.lab_reports_raw.deleteOne({ request_id: 3 });

// Extended operations (added depth)
// deleteMany -- purge raw reports older than the 7-year retention window
db.lab_reports_raw.deleteMany({ report_date: { $lt: ISODate("2019-09-16T00:00:00Z") } });
