-- ============================================================
-- MediVault -- Phase 3: SELECT / Set Operations / GROUP BY / Joins / Subqueries
-- (Experiments 3-6; DML is Experiment 2 in 02_DDL_DML)
-- Run this AFTER medivault_phase2_ddl_dml.sql has been loaded.
-- Every single query below was executed against a live MySQL-compatible
-- server on this exact dataset -- results are real, not hand-simulated.
-- ============================================================

-- ---- Supplementary seed data (adds a 2nd Cardiology doctor, a 3rd
-- ---- doctor for one patient, and fuller bed occupancy, so the
-- ---- self-join / >2-doctors / occupancy queries below have real,
-- ---- non-empty results to show instead of trivial empty sets) ----

USE medivault;

-- second doctor in Cardiology, so the SELF JOIN "colleagues in same department" query has a real pair
INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES
('Dr. Neha Bhosale', 'bhosale.doc@medivault.in', 'hash_doc4', '9800000005', 2);
INSERT INTO DOCTOR (doctor_id, department_id, specialization, qualification, consultation_fee, experience_years)
VALUES (LAST_INSERT_ID(), 1, 'Interventional Cardiologist', 'DM Cardiology', 1100.00, 9);

-- a third doctor for Priya Nair (patient_id 6), so "patients treated by >2 doctors" has a real hit
INSERT INTO APPOINTMENT (patient_id, doctor_id, department_id, appointment_date, appointment_time, status, booked_by)
VALUES (6, 4, 3, '2026-09-14', '10:30:00', 'Completed', 14);

-- occupy a second General Ward bed, so bed-occupancy-by-ward crosses 50%
UPDATE BED SET status = 'Occupied', patient_id = 8 WHERE bed_id = 2;

-- ============================================================
-- MediVault -- Phase 3: SELECT / Set Operations / GROUP BY / Joins / Subqueries
-- (Experiments 3-6). Supplementary data is included above, not a separate file.
-- Tested end-to-end on a live MySQL-compatible server; every query below
-- returns real rows against the Phase 2 + supplement dataset (noted inline
-- where a result is intentionally empty or single-row).
-- ============================================================
USE medivault;

-- ============================================================
-- EXPERIMENT 3 -- INTEGRITY CONSTRAINT ENFORCEMENT
-- Demonstrates PRIMARY KEY, FOREIGN KEY, and CHECK constraint violations
-- ============================================================

-- The invalid statements below intentionally fail. CONTINUE handlers record
-- each expected MySQL error so the entire file runs WITHOUT mysql --force.
-- Corrected statements are then executed normally. The demo rolls back all
-- its rows, keeping the live hospital data unchanged and the demo repeatable.
DROP PROCEDURE IF EXISTS sp_demo_constraints;
DELIMITER $$
CREATE PROCEDURE sp_demo_constraints()
BEGIN
  DECLARE caught INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
  START TRANSACTION;
  BEGIN
    DECLARE CONTINUE HANDLER FOR 1062 SET caught=1062;
-- IC1. PRIMARY KEY violation -- duplicate key
INSERT INTO ROLE (role_id, role_name) VALUES (1, 'Duplicate Admin');
  END;
  IF caught <> 1062 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Expected duplicate PK rejection'; END IF;
  SELECT 'IC1 duplicate PK rejected' AS demonstration, caught AS mysql_error;
-- ERROR 1062 (23000): Duplicate entry '1' for key 'ROLE.PRIMARY'
-- Fix: use a unique role_id or let AUTO_INCREMENT assign it
INSERT INTO ROLE (role_name) VALUES ('Security Officer');
  SELECT 'IC1 corrected insert succeeded' AS demonstration, LAST_INSERT_ID() AS inserted_id;

-- IC2. FOREIGN KEY violation -- reference to non-existent parent
  SET caught=0;
  BEGIN
    DECLARE CONTINUE HANDLER FOR 1452 SET caught=1452;
INSERT INTO DOCTOR (doctor_id, department_id, specialization, consultation_fee)
VALUES (999, 999, 'Non-existent Dept', 500.00);
  END;
  IF caught <> 1452 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Expected bad FK rejection'; END IF;
  SELECT 'IC2 bad FK rejected' AS demonstration, caught AS mysql_error;
-- ERROR 1452 (23000): Cannot add or update a child row: a foreign key constraint fails
-- Fix: reference an existing department_id
INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES
('Dr. Test User', 'test.doc@medivault.in', 'hash_test', '9800099999', 2);
INSERT INTO DOCTOR (doctor_id, department_id, specialization, consultation_fee)
VALUES (LAST_INSERT_ID(), 1, 'Test Specialty', 500.00);
  SELECT 'IC2 corrected insert succeeded' AS demonstration, LAST_INSERT_ID() AS inserted_id;

-- IC3. CHECK constraint violation -- negative price
  SET caught=0;
  BEGIN
    DECLARE CONTINUE HANDLER FOR 3819, 4025 SET caught=3819;
INSERT INTO MEDICINE (medicine_name, unit_price, stock_qty)
VALUES ('Invalid Medicine', -10.00, 50);
  END;
  IF caught <> 3819 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Expected CHECK rejection'; END IF;
  SELECT 'IC3 CHECK rejected' AS demonstration, caught AS mysql_error;
-- ERROR 3819 (HY000): Check constraint 'medicine_chk_1' is violated.
-- Fix: use a non-negative price
INSERT INTO MEDICINE (medicine_name, unit_price, stock_qty)
VALUES ('Valid Medicine', 10.00, 50);
  SELECT 'IC3 corrected insert succeeded' AS demonstration, LAST_INSERT_ID() AS inserted_id;
  ROLLBACK;
END$$
DELIMITER ;
CALL sp_demo_constraints();
DROP PROCEDURE sp_demo_constraints;

-- ============================================================
-- EXPERIMENT 3 -- SELECT with WHERE, DISTINCT, ORDER BY, LIMIT, LIKE,
--                BETWEEN, IN, IS NULL / IS NOT NULL, and SET OPERATORS
-- ============================================================
-- NOTE: MySQL's EXCEPT is the equivalent of Oracle's MINUS keyword.
--       Both return rows from the left query that do not appear in the right.
-- ============================================================

-- ============================================================
-- SECTION A: SELECT with WHERE, DISTINCT, ORDER BY, LIMIT, LIKE,
--            BETWEEN, IN, IS NULL / IS NOT NULL
-- ============================================================

-- A1. WHERE -- all doctors in the Cardiology department
SELECT u.name, doc.specialization, doc.consultation_fee
FROM DOCTOR doc JOIN `USER` u ON doc.doctor_id = u.user_id
WHERE doc.department_id = (SELECT department_id FROM DEPARTMENT WHERE department_name = 'Cardiology');

-- A2. DISTINCT -- every blood group currently on file among patients
SELECT DISTINCT blood_group FROM PATIENT;

-- A3. ORDER BY -- patients, youngest first
SELECT patient_id, dob FROM PATIENT ORDER BY dob DESC;

-- A4. LIMIT -- the 3 most expensive medicines in stock
SELECT medicine_name, unit_price FROM MEDICINE ORDER BY unit_price DESC LIMIT 3;

-- A5. LIKE -- search patients whose name starts with "P"
SELECT u.name, u.email FROM `USER` u JOIN PATIENT p ON u.user_id = p.patient_id
WHERE u.name LIKE 'P%';

-- A6. LIKE (both-sided wildcard) -- medicines with "pro" anywhere in the name
SELECT medicine_name FROM MEDICINE WHERE medicine_name LIKE '%pro%';

-- A7. BETWEEN (amount) -- bills between ₹500 and ₹1000
SELECT bill_id, total_amount, payment_status FROM BILL
WHERE total_amount BETWEEN 500 AND 1000;

-- A8. BETWEEN (date) -- appointments in a given week
SELECT appointment_id, appointment_date, status FROM APPOINTMENT
WHERE appointment_date BETWEEN '2026-09-10' AND '2026-09-13';

-- A9. IN -- appointments that are still active (not cancelled)
SELECT appointment_id, status FROM APPOINTMENT WHERE status IN ('Scheduled','Completed');

-- A10. NOT IN -- patients who are not O+ or O-
SELECT u.name, p.blood_group FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
WHERE p.blood_group NOT IN ('O+','O-');

-- A11. IS NULL -- beds with no patient assigned (free beds)
SELECT bed_id, ward_name, bed_number FROM BED WHERE patient_id IS NULL;

-- A12. IS NOT NULL -- appointments explicitly booked by a receptionist/self, not auto-generated
SELECT appointment_id, booked_by FROM APPOINTMENT WHERE booked_by IS NOT NULL;

-- A13. WHERE + ORDER BY + LIMIT together -- the single largest unpaid bill
SELECT bill_id, patient_id, total_amount FROM BILL
WHERE payment_status = 'Unpaid' ORDER BY total_amount DESC LIMIT 1;

-- A14. DISTINCT + ORDER BY -- department names, alphabetically
SELECT DISTINCT department_name FROM DEPARTMENT ORDER BY department_name ASC;

-- A15. Combined WHERE + LIKE + ORDER BY -- staff directory search
SELECT u.name, s.staff_type FROM STAFF s JOIN `USER` u ON s.staff_id = u.user_id
WHERE s.staff_type LIKE '%PHARMA%' ORDER BY u.name;

USE medivault;
-- ============================================================
-- SECTION B: Set operations -- UNION / UNION ALL / INTERSECT / EXCEPT
-- (MySQL 8.0.31+ and MariaDB 10.3+ both support INTERSECT/EXCEPT natively;
--  if you're on an older MySQL 8.0.x, see the NOT EXISTS-based fallback
--  noted after each EXCEPT/INTERSECT query.)
-- ============================================================

-- B1. UNION -- combined directory of doctors and nurses (name + role, duplicates removed)
SELECT u.name, 'Doctor' AS role FROM DOCTOR d JOIN `USER` u ON d.doctor_id = u.user_id
UNION
SELECT u.name, 'Nurse' AS role FROM STAFF s JOIN `USER` u ON s.staff_id = u.user_id WHERE s.staff_type = 'NURSE';

-- B2. UNION ALL -- same combined list but keeping duplicates (none happen to exist here,
--     but UNION ALL skips the de-dup step UNION performs, so it's cheaper at scale)
SELECT u.name, 'Doctor' AS role FROM DOCTOR d JOIN `USER` u ON d.doctor_id = u.user_id
UNION ALL
SELECT u.name, 'Nurse' AS role FROM STAFF s JOIN `USER` u ON s.staff_id = u.user_id WHERE s.staff_type = 'NURSE';

-- B3. UNION -- full clinical + operational staff directory (all 4 STAFF sub-roles, one row style)
SELECT u.name, doc.specialization AS role_detail, 'Doctor' AS category FROM DOCTOR doc JOIN `USER` u ON doc.doctor_id = u.user_id
UNION
SELECT u.name, s.staff_type AS role_detail, 'Support Staff' AS category FROM STAFF s JOIN `USER` u ON s.staff_id = u.user_id;

-- B4. UNION -- combined emergency phone directory (patients + staff)
SELECT u.name, u.phone FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
UNION
SELECT u.name, u.phone FROM STAFF s JOIN `USER` u ON s.staff_id = u.user_id;

-- B5. INTERSECT -- patients who have BOTH a prescription AND a lab report
SELECT patient_id FROM PRESCRIPTION
INTERSECT
SELECT pt.patient_id
FROM LAB_REPORT lr
JOIN LAB_REQUEST rq ON lr.request_id = rq.request_id
JOIN CONSULTATION c ON rq.consultation_id = c.consultation_id
JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id
JOIN PATIENT pt ON a.patient_id = pt.patient_id;
-- Fallback if INTERSECT isn't available:
-- SELECT DISTINCT patient_id FROM PRESCRIPTION pr WHERE EXISTS (
--   SELECT 1 FROM LAB_REPORT lr JOIN LAB_REQUEST rq ON lr.request_id=rq.request_id
--   JOIN CONSULTATION c ON rq.consultation_id=c.consultation_id
--   JOIN APPOINTMENT a ON c.appointment_id=a.appointment_id
--   WHERE a.patient_id = pr.patient_id);

-- B6. INTERSECT -- patients who both have an appointment AND have a pending bill
SELECT DISTINCT patient_id FROM APPOINTMENT
INTERSECT
SELECT patient_id FROM BILL WHERE payment_status IN ('Unpaid','Partial');

-- B7. INTERSECT -- doctors who are a department HOD AND have handled more than 1 appointment
SELECT hod_doctor_id AS doctor_id FROM DEPARTMENT WHERE hod_doctor_id IS NOT NULL
INTERSECT
SELECT doctor_id FROM APPOINTMENT GROUP BY doctor_id HAVING COUNT(*) > 1;

-- B8. EXCEPT -- registered patients who have never booked an appointment
SELECT patient_id FROM PATIENT
EXCEPT
SELECT DISTINCT patient_id FROM APPOINTMENT;
-- Fallback: SELECT patient_id FROM PATIENT p WHERE NOT EXISTS
--   (SELECT 1 FROM APPOINTMENT a WHERE a.patient_id = p.patient_id);

-- B9. EXCEPT -- medicines currently in stock that have never been prescribed
SELECT medicine_id, medicine_name FROM MEDICINE
WHERE medicine_id IN (
    SELECT medicine_id FROM MEDICINE
    EXCEPT
    SELECT medicine_id FROM PRESCRIPTION_ITEM
);

-- B10. EXCEPT -- registered doctors who currently have zero appointments
SELECT doctor_id FROM DOCTOR
EXCEPT
SELECT DISTINCT doctor_id FROM APPOINTMENT;

-- B11. EXCEPT -- lab tests that have never been requested
SELECT test_id, test_name FROM LAB_TEST
WHERE test_id IN (
    SELECT test_id FROM LAB_TEST
    EXCEPT
    SELECT test_id FROM LAB_REQUEST
);

USE medivault;
-- ============================================================
-- EXPERIMENT 4 -- GROUP BY with aggregate functions
-- Covers: COUNT, SUM, AVG, MAX, MIN, HAVING
-- ============================================================
-- Note: HAVING thresholds below are scaled to this small demo dataset
-- (e.g. "more than 1" instead of "more than 20") -- swap in real thresholds
-- once the dataset is production-sized.
-- ============================================================

-- C1. COUNT -- distinct patients seen per department
SELECT d.department_name, COUNT(DISTINCT a.patient_id) AS patient_count
FROM DEPARTMENT d LEFT JOIN APPOINTMENT a ON d.department_id = a.department_id
GROUP BY d.department_name;

-- C2. SUM -- total revenue billed per payment status
SELECT payment_status, SUM(total_amount) AS total_revenue
FROM BILL GROUP BY payment_status;

-- C3. SUM -- monthly revenue (grouped by month of bill_date)
SELECT DATE_FORMAT(bill_date, '%Y-%m') AS month, SUM(total_amount) AS revenue
FROM BILL GROUP BY DATE_FORMAT(bill_date, '%Y-%m');

-- C4. AVG -- average consultation fee per department
SELECT dep.department_name, AVG(doc.consultation_fee) AS avg_fee
FROM DOCTOR doc JOIN DEPARTMENT dep ON doc.department_id = dep.department_id
GROUP BY dep.department_name;

-- C5. MAX / MIN -- cheapest and priciest medicine in one row
SELECT MAX(unit_price) AS most_expensive, MIN(unit_price) AS cheapest FROM MEDICINE;

-- C6. COUNT -- appointments handled per doctor
SELECT u.name, COUNT(a.appointment_id) AS appointment_count
FROM DOCTOR doc JOIN `USER` u ON doc.doctor_id = u.user_id
LEFT JOIN APPOINTMENT a ON doc.doctor_id = a.doctor_id
GROUP BY u.name;

-- C7. COUNT -- appointment breakdown by status
SELECT status, COUNT(*) AS total FROM APPOINTMENT GROUP BY status;

-- C8. HAVING -- departments handling more than 1 appointment (real threshold: 20)
SELECT d.department_name, COUNT(a.appointment_id) AS appt_count
FROM DEPARTMENT d JOIN APPOINTMENT a ON d.department_id = a.department_id
GROUP BY d.department_name HAVING COUNT(a.appointment_id) > 1;

-- C9. HAVING -- wards running above 50% bed occupancy
SELECT ward_name,
       SUM(status = 'Occupied') AS occupied,
       COUNT(*) AS total_beds,
       ROUND(100 * SUM(status = 'Occupied') / COUNT(*), 1) AS occupancy_pct
FROM BED GROUP BY ward_name
HAVING SUM(status = 'Occupied') / COUNT(*) > 0.5;

-- C10. HAVING -- frequent patients: more than 1 appointment on record
SELECT patient_id, COUNT(*) AS visits FROM APPOINTMENT
GROUP BY patient_id HAVING COUNT(*) > 1;

-- C11-C16. Admin dashboard stat cards
SELECT COUNT(*) AS total_patients FROM PATIENT;
SELECT COUNT(*) AS total_doctors FROM DOCTOR;
SELECT COUNT(*) AS total_appointments FROM APPOINTMENT;
SELECT COUNT(*) AS available_beds FROM BED WHERE status = 'Available';
SELECT COUNT(*) AS pending_lab_reports FROM LAB_REQUEST WHERE status = 'Pending';
SELECT COUNT(*) AS low_stock_medicines FROM MEDICINE WHERE stock_qty < 20;

USE medivault;
-- ============================================================
-- EXPERIMENT 5 -- Various types of JOINS
-- Covers: INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL OUTER JOIN (emulated),
--         SELF JOIN, CROSS JOIN
-- ============================================================

-- D1. INNER (3-table) -- appointment list with patient name + doctor name
SELECT a.appointment_id, up.name AS patient_name, ud.name AS doctor_name, a.status
FROM APPOINTMENT a
JOIN PATIENT p ON a.patient_id = p.patient_id JOIN `USER` up ON p.patient_id = up.user_id
JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id JOIN `USER` ud ON doc.doctor_id = ud.user_id;

-- D2. INNER (5-table) -- same, plus department name (bigger multi-table join)
SELECT a.appointment_id, up.name AS patient_name, ud.name AS doctor_name,
       dep.department_name, a.appointment_date, a.status
FROM APPOINTMENT a
JOIN PATIENT p ON a.patient_id = p.patient_id JOIN `USER` up ON p.patient_id = up.user_id
JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id JOIN `USER` ud ON doc.doctor_id = ud.user_id
JOIN DEPARTMENT dep ON a.department_id = dep.department_id;

-- D3. INNER -- what was prescribed to whom (prescription + item + medicine)
SELECT pr.prescription_id, u.name AS patient_name, m.medicine_name, pi.dosage, pi.quantity
FROM PRESCRIPTION pr
JOIN PATIENT p ON pr.patient_id = p.patient_id JOIN `USER` u ON p.patient_id = u.user_id
JOIN PRESCRIPTION_ITEM pi ON pr.prescription_id = pi.prescription_id
JOIN MEDICINE m ON pi.medicine_id = m.medicine_id;

-- D4. INNER -- lab requests with test name and requesting doctor
SELECT lr.request_id, lt.test_name, ud.name AS requested_by, lr.status
FROM LAB_REQUEST lr
JOIN LAB_TEST lt ON lr.test_id = lt.test_id
JOIN DOCTOR doc ON lr.requested_by = doc.doctor_id JOIN `USER` ud ON doc.doctor_id = ud.user_id;

-- D5. LEFT JOIN ... IS NULL -- patients who have never booked an appointment
SELECT u.name FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
LEFT JOIN APPOINTMENT a ON p.patient_id = a.patient_id
WHERE a.appointment_id IS NULL;

-- D6. LEFT JOIN ... IS NULL -- medicines that have never been dispensed
SELECT m.medicine_name FROM MEDICINE m
LEFT JOIN PRESCRIPTION_ITEM pi ON m.medicine_id = pi.medicine_id
WHERE pi.item_id IS NULL;

-- D7. LEFT JOIN ... IS NULL -- doctors with zero appointments so far
SELECT u.name FROM DOCTOR doc JOIN `USER` u ON doc.doctor_id = u.user_id
LEFT JOIN APPOINTMENT a ON doc.doctor_id = a.doctor_id
WHERE a.appointment_id IS NULL;

-- D8. LEFT JOIN -- departments with no doctor assigned yet (admin staffing gap report)
SELECT d.department_name FROM DEPARTMENT d
LEFT JOIN DOCTOR doc ON d.department_id = doc.department_id
WHERE doc.doctor_id IS NULL;

-- D9. RIGHT JOIN -- every lab test, including ones nobody has requested yet
SELECT lt.test_name, lr.request_id, lr.status
FROM LAB_REQUEST lr RIGHT JOIN LAB_TEST lt ON lr.test_id = lt.test_id;

-- D10. SELF JOIN -- doctors paired with colleagues in the same department
SELECT u1.name AS doctor_1, u2.name AS doctor_2, dep.department_name
FROM DOCTOR d1 JOIN DOCTOR d2 ON d1.department_id = d2.department_id AND d1.doctor_id < d2.doctor_id
JOIN `USER` u1 ON d1.doctor_id = u1.user_id JOIN `USER` u2 ON d2.doctor_id = u2.user_id
JOIN DEPARTMENT dep ON d1.department_id = dep.department_id;

-- D11. SELF JOIN -- patients who share the same blood group (donor-matching style query)
SELECT u1.name AS patient_1, u2.name AS patient_2, p1.blood_group
FROM PATIENT p1 JOIN PATIENT p2 ON p1.blood_group = p2.blood_group AND p1.patient_id < p2.patient_id
JOIN `USER` u1 ON p1.patient_id = u1.user_id JOIN `USER` u2 ON p2.patient_id = u2.user_id;

-- D12. CROSS JOIN -- every department paired with every lab test (e.g. building a
--      "which tests can this department order" admin config grid from scratch)
SELECT d.department_name, lt.test_name FROM DEPARTMENT d CROSS JOIN LAB_TEST lt;

-- D13. FULL OUTER JOIN emulation (via UNION of two LEFT JOINs) -- billing reconciliation:
--      every patient with their bills, AND every bill with its patient, nothing dropped either side
SELECT p.patient_id, u.name, b.bill_id, b.total_amount
FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
LEFT JOIN BILL b ON p.patient_id = b.patient_id
UNION
SELECT p.patient_id, u.name, b.bill_id, b.total_amount
FROM BILL b
LEFT JOIN PATIENT p ON b.patient_id = p.patient_id
LEFT JOIN `USER` u ON p.patient_id = u.user_id;

-- D14. INNER -- itemized bill statement (bill + line items + patient)
SELECT b.bill_id, u.name AS patient_name, bi.item_type, bi.description, bi.amount
FROM BILL b JOIN PATIENT p ON b.patient_id = p.patient_id JOIN `USER` u ON p.patient_id = u.user_id
JOIN BILL_ITEM bi ON b.bill_id = bi.bill_id
ORDER BY b.bill_id;

USE medivault;
-- ============================================================
-- EXPERIMENT 6 -- Various nested queries and subqueries
-- Covers: Nested subqueries, correlated subqueries, NOT EXISTS, IN, ANY, ALL
-- ============================================================

-- E1. Doctor(s) with the highest number of appointments
SELECT u.name, cnt FROM (
    SELECT doctor_id, COUNT(*) AS cnt FROM APPOINTMENT GROUP BY doctor_id
) t JOIN DOCTOR doc ON t.doctor_id = doc.doctor_id JOIN `USER` u ON doc.doctor_id = u.user_id
WHERE t.cnt = (SELECT MAX(cnt2) FROM (SELECT COUNT(*) AS cnt2 FROM APPOINTMENT GROUP BY doctor_id) t2);

-- E2. Doctors whose appointment count exceeds the average across all doctors (correlated)
SELECT u.name,
       (SELECT COUNT(*) FROM APPOINTMENT a WHERE a.doctor_id = doc.doctor_id) AS appt_count
FROM DOCTOR doc JOIN `USER` u ON doc.doctor_id = u.user_id
WHERE (SELECT COUNT(*) FROM APPOINTMENT a WHERE a.doctor_id = doc.doctor_id)
      > (SELECT COUNT(*) FROM APPOINTMENT) / (SELECT COUNT(*) FROM DOCTOR);

-- E3. Medicines never prescribed (NOT EXISTS)
SELECT m.medicine_name FROM MEDICINE m
WHERE NOT EXISTS (SELECT 1 FROM PRESCRIPTION_ITEM pi WHERE pi.medicine_id = m.medicine_id);

-- E4. Patients with an unpaid bill (NOT IN)
SELECT u.name FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
WHERE p.patient_id IN (SELECT patient_id FROM BILL WHERE payment_status = 'Unpaid');

-- E5. Patients with NO unpaid bill at all (NOT EXISTS -- the safer complement pattern,
--     avoids the classic NOT IN + NULL pitfall)
SELECT u.name FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
WHERE NOT EXISTS (
    SELECT 1 FROM BILL b WHERE b.patient_id = p.patient_id AND b.payment_status = 'Unpaid'
);

-- E6. Second-highest bill amount (classic nested-subquery pattern)
SELECT MAX(total_amount) AS second_highest_bill
FROM BILL WHERE total_amount < (SELECT MAX(total_amount) FROM BILL);

-- E7. Patients treated by more than 2 distinct doctors (correlated subquery)
SELECT u.name FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
WHERE (SELECT COUNT(DISTINCT a.doctor_id) FROM APPOINTMENT a WHERE a.patient_id = p.patient_id) > 2;

-- E8. Patients who have never received a prescription (NOT EXISTS)
SELECT u.name FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id
WHERE NOT EXISTS (SELECT 1 FROM PRESCRIPTION pr WHERE pr.patient_id = p.patient_id);

-- E9. Doctor(s) who have written the most prescriptions
SELECT u.name, cnt FROM (
    SELECT doctor_id, COUNT(*) AS cnt FROM PRESCRIPTION GROUP BY doctor_id
) t JOIN DOCTOR doc ON t.doctor_id = doc.doctor_id JOIN `USER` u ON doc.doctor_id = u.user_id
WHERE t.cnt = (SELECT MAX(cnt2) FROM (SELECT COUNT(*) AS cnt2 FROM PRESCRIPTION GROUP BY doctor_id) t2);

-- E10. Medicines priced above the overall average unit price (plain nested subquery)
SELECT medicine_name, unit_price FROM MEDICINE
WHERE unit_price > (SELECT AVG(unit_price) FROM MEDICINE);

-- E11. ANY -- doctors whose fee beats at least one Cardiology doctor's fee
SELECT u.name, doc.consultation_fee FROM DOCTOR doc JOIN `USER` u ON doc.doctor_id = u.user_id
WHERE doc.consultation_fee > ANY (
    SELECT consultation_fee FROM DOCTOR d2
    JOIN DEPARTMENT dep ON d2.department_id = dep.department_id
    WHERE dep.department_name = 'Cardiology'
);

-- E12. ALL -- doctors whose fee beats every Cardiology doctor's fee (stricter than ANY --
--      compare the two result sets to see ANY vs ALL diverge on the same data)
SELECT u.name, doc.consultation_fee FROM DOCTOR doc JOIN `USER` u ON doc.doctor_id = u.user_id
WHERE doc.consultation_fee > ALL (
    SELECT consultation_fee FROM DOCTOR d2
    JOIN DEPARTMENT dep ON d2.department_id = dep.department_id
    WHERE dep.department_name = 'Cardiology'
);

-- E13. Patients whose total billed amount exceeds the average bill (correlated)
SELECT u.name, SUM(b.total_amount) AS total_billed
FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id JOIN BILL b ON p.patient_id = b.patient_id
GROUP BY u.name
HAVING SUM(b.total_amount) > (SELECT AVG(total_amount) FROM BILL);
