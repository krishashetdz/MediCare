-- ============================================================================
-- MediCare / MediVault -- MySQL Workbench Report Snapshot Script
-- Covers Report Sections:
--   iii] Database Table Snapshots (schema + populated rows)
--   v]   SQL Queries: INSERT, UPDATE, DELETE, VIEWS, TRIGGERS
--
-- HOW TO USE IN MYSQL WORKBENCH:
--   Run ONE numbered block at a time (highlight the block -> Ctrl+Shift+Enter)
--   and take a screenshot of the Query Editor + Result Grid + Action Output.
--   All UPDATE/DELETE statements use primary keys (SQL_SAFE_UPDATES = 1 safe).
-- ============================================================================

USE medivault;

-- ============================================================================
-- SECTION iii] DATABASE TABLE SNAPSHOTS (DATA INSERTED)
-- ============================================================================

-- iii.1 List all tables & views in the database
SHOW FULL TABLES;

-- iii.2 Core Identity & Clinical Tables (run individually for clean screenshots)
SELECT * FROM ROLE;
SELECT user_id, name, email, phone, role_id, is_active FROM `USER`;
SELECT * FROM DEPARTMENT;
SELECT * FROM DOCTOR;
SELECT * FROM PATIENT;
SELECT * FROM PATIENT_ALLERGY;
SELECT * FROM STAFF;

-- iii.3 Outpatient, Pharmacy, Ward & Billing Tables
SELECT * FROM APPOINTMENT;
SELECT * FROM CONSULTATION;
SELECT * FROM MEDICINE;
SELECT * FROM MEDICINE_BATCH;
SELECT * FROM PRESCRIPTION;
SELECT * FROM PRESCRIPTION_ITEM;
SELECT * FROM WARD;
SELECT * FROM BED;
SELECT * FROM ADMISSION;
SELECT * FROM BILL;
SELECT * FROM BILL_ITEM;
SELECT * FROM PAYMENT;
SELECT * FROM NOTIFICATION;

-- ============================================================================
-- SECTION v.1] INSERT QUERIES (with BEFORE / AFTER verification)
-- ============================================================================

-- v.1a INSERT a new allergy for Patient 7 (Amit Deshmukh)
SELECT * FROM PATIENT_ALLERGY WHERE patient_id = 7;

INSERT INTO PATIENT_ALLERGY (patient_id, allergy_name, severity)
VALUES (7, 'Pollen', 'Mild');

SELECT * FROM PATIENT_ALLERGY WHERE patient_id = 7;

-- v.1b INSERT a new appointment for TODAY (CURDATE())
-- NOTE: This also populates vw_doctor_today_schedule AND fires trg_appointment_notification!
SELECT * FROM NOTIFICATION WHERE user_id = 8;

INSERT INTO APPOINTMENT (patient_id, doctor_id, appointment_date, appointment_time, status, booked_by)
VALUES (8, 2, CURDATE(), '10:30:00', 'Scheduled', 14);
SET @wb_appt_id = LAST_INSERT_ID();

SELECT * FROM APPOINTMENT WHERE appointment_id = @wb_appt_id;
-- Verify trigger automatically inserted a booking notification for patient 8:
SELECT * FROM NOTIFICATION WHERE user_id = 8 ORDER BY notification_id DESC LIMIT 3;

-- ============================================================================
-- SECTION v.2] UPDATE QUERIES (with BEFORE / AFTER verification)
-- ============================================================================

-- v.2a UPDATE appointment status from 'Scheduled' to 'Confirmed'
SELECT appointment_id, patient_id, doctor_id, appointment_date, status
FROM APPOINTMENT WHERE appointment_id = @wb_appt_id;

UPDATE APPOINTMENT
SET status = 'Confirmed'
WHERE appointment_id = @wb_appt_id;

SELECT appointment_id, patient_id, doctor_id, appointment_date, status
FROM APPOINTMENT WHERE appointment_id = @wb_appt_id;

-- v.2b UPDATE medicine batch stock (restock Metformin active batch_id = 5)
SELECT * FROM vw_pharmacy_low_stock;

UPDATE MEDICINE_BATCH
SET available_qty = available_qty + 100
WHERE batch_id = 5;

-- Metformin (medicine_id = 5) now has 115 active units and drops out of vw_pharmacy_low_stock:
SELECT medicine_id, medicine_name, stock_qty FROM vw_medicine_inventory WHERE medicine_id = 5;
SELECT * FROM vw_pharmacy_low_stock;

-- ============================================================================
-- SECTION v.3] DELETE QUERIES (with BEFORE / AFTER verification)
-- ============================================================================

-- v.3a Create a temporary bill + 2 items, then DELETE one item to show vw_bill_summary recalculate
INSERT INTO BILL (patient_id, appointment_id, generated_by) VALUES (7, NULL, 14);
SET @wb_bill_id = LAST_INSERT_ID();

INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (@wb_bill_id, 'Lab', 'CBC', 350.00);
INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (@wb_bill_id, 'Medicine', 'Paracetamol', 50.00);
SET @wb_item_id = LAST_INSERT_ID();

SELECT 'BEFORE DELETE: bill total is 400.00' AS step;
SELECT bill_id, total_amount, payment_status FROM vw_bill_summary WHERE bill_id = @wb_bill_id;

DELETE FROM BILL_ITEM WHERE bill_item_id = @wb_item_id;

SELECT 'AFTER DELETE: bill total drops to 350.00 automatically' AS step;
SELECT bill_id, total_amount, payment_status FROM vw_bill_summary WHERE bill_id = @wb_bill_id;

-- Cleanup temporary demo bill so database stays tidy
DELETE FROM BILL WHERE bill_id = @wb_bill_id;

-- ============================================================================
-- SECTION v.4] VIEWS (run each SELECT to screenshot the live virtual table)
-- ============================================================================

-- List all views in medivault
SHOW FULL TABLES WHERE Table_type = 'VIEW';

-- Core 3NF & Dashboard Views
SELECT * FROM vw_doctor_today_schedule;
SELECT * FROM vw_patient_portal_summary;
SELECT * FROM vw_medicine_inventory;
SELECT * FROM vw_pharmacy_low_stock;
SELECT * FROM vw_bill_summary;
SELECT * FROM vw_bed_details;
SELECT * FROM vw_bed_occupancy;
SELECT * FROM vw_monthly_revenue;
SELECT * FROM vw_reception_dashboard;

-- ============================================================================
-- SECTION v.5] TRIGGERS (inspect + test all 4 triggers)
-- ============================================================================

-- v.5a Show all triggers registered in medivault
SHOW TRIGGERS;

-- v.5b Trigger 1 & 2: trg_update_stock -> chains into trg_low_stock_alert
-- Set Pantoprazole (batch_id = 7) to 25 units, create a prescription for 10 units, dispense it.
-- Stock drops 25 -> 15 (crossing below 20), which fires trg_low_stock_alert for Admin & Pharmacist!
UPDATE MEDICINE_BATCH SET available_qty = 25 WHERE batch_id = 7;

INSERT INTO PRESCRIPTION (consultation_id, status) VALUES (2, 'Pending');
SET @wb_presc_id = LAST_INSERT_ID();

INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, duration_days, quantity)
VALUES (@wb_presc_id, 7, '1-0-1', 5, 10);

SELECT 'BEFORE DISPENSE' AS step, stock_qty FROM vw_medicine_inventory WHERE medicine_id = 7;

UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = @wb_presc_id;

SELECT 'AFTER DISPENSE (25 -> 15)' AS step, stock_qty FROM vw_medicine_inventory WHERE medicine_id = 7;
SELECT n.notification_id, u.name AS recipient, n.message, n.created_at
FROM NOTIFICATION n
JOIN `USER` u ON n.user_id = u.user_id
WHERE n.message LIKE 'Low stock alert: Pantoprazole%'
ORDER BY n.notification_id DESC;

-- v.5c Trigger 3: trg_appointment_notification (already verified in v.1b above)

-- v.5d Trigger 4: trg_block_patient_delete (BLOCKED CASE - screenshot the red error in Action Output!)
-- Patient 6 (Priya Nair) has unpaid Bill #2 (₹700). Highlight and run ONLY the next line:
-- DELETE FROM PATIENT WHERE patient_id = 6;
-- Expected Action Output:
--   Error Code: 1644. Cannot delete patient: unpaid or partial bills exist

-- v.5e Trigger 4: trg_block_patient_delete (ALLOWED CASE - patient with zero bills)
INSERT INTO `USER` (name, email, password_hash, phone, role_id)
VALUES ('Temp Test Patient', 'temp.test.patient@example.com', '$2a$10$v1L1KWnJoT52YPFjadbqQOYeEifxGzBaQwu45Y97whb1IOS7r57cW', '9000000099', 3);
SET @temp_pid = LAST_INSERT_ID();
INSERT INTO PATIENT (patient_id, gender) VALUES (@temp_pid, 'F');

DELETE FROM PATIENT WHERE patient_id = @temp_pid;
DELETE FROM `USER` WHERE user_id = @temp_pid;
SELECT 'Allowed delete succeeded for patient with zero unpaid bills' AS result;
