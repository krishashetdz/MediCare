-- ============================================================
-- MediVault -- Phase 4 DEMO -- exercises every view/trigger/procedure
-- above against live data (creates/mutates test rows). Run this AFTER
-- medivault_phase4_views_triggers_procs.sql, only when you want to see
-- the effects for yourself or grab screenshots for the Phase 7 report.
-- ============================================================

-- ============================================================
-- MediVault -- Phase 4d: DEMO -- exercising every view/trigger/procedure
-- against the live dataset, with before/after SELECTs so the effect is visible.
-- (Good source material for the screenshots section of the Phase 7 report.)
-- ============================================================
USE medivault;

-- ---------------------------------------------------------------
-- DEMO 1: updatable view -- restock Metformin straight through vw_pharmacy_low_stock
-- ---------------------------------------------------------------
SELECT 'BEFORE: low-stock list' AS step;
SELECT * FROM vw_pharmacy_low_stock;

UPDATE vw_pharmacy_low_stock SET stock_qty = stock_qty + 100 WHERE medicine_id = 5;

SELECT 'AFTER: base MEDICINE row actually changed' AS step;
SELECT medicine_id, medicine_name, stock_qty FROM MEDICINE WHERE medicine_id = 5;
SELECT 'AFTER: Metformin drops out of the low-stock view (no longer < 20)' AS step;
SELECT * FROM vw_pharmacy_low_stock;

-- ---------------------------------------------------------------
-- DEMO 2: trg_appointment_notification
-- ---------------------------------------------------------------
SELECT 'BEFORE: notifications for patient 7' AS step;
SELECT * FROM NOTIFICATION WHERE user_id = 7;

INSERT INTO APPOINTMENT (patient_id, doctor_id, department_id, appointment_date, appointment_time, status, booked_by)
VALUES (7, 4, 3, '2026-09-20', '11:00:00', 'Scheduled', 14);
SET @demo_appt_id = LAST_INSERT_ID();

SELECT 'AFTER: a notification appeared automatically' AS step;
SELECT * FROM NOTIFICATION WHERE user_id = 7;

-- ---------------------------------------------------------------
-- DEMO 3: trg_update_stock -> chains into trg_low_stock_alert
-- Set Pantoprazole to a moderate 25 units, prescribe 10 of them, dispense --
-- watch stock cross below 20 AND an alert notification appear, from ONE UPDATE.
-- ---------------------------------------------------------------
UPDATE MEDICINE SET stock_qty = 25 WHERE medicine_id = 7;

INSERT INTO PRESCRIPTION (consultation_id, patient_id, doctor_id, status)
VALUES (2, 6, 3, 'Pending');
SET @new_presc_id = LAST_INSERT_ID();

INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, duration_days, quantity)
VALUES (@new_presc_id, 7, '1-0-1', 5, 10);

SELECT 'BEFORE dispensing: Pantoprazole stock, and any Admin/Pharmacist low-stock alerts' AS step;
SELECT stock_qty FROM MEDICINE WHERE medicine_id = 7;
SELECT n.notification_id, u.name, n.message FROM NOTIFICATION n JOIN `USER` u ON n.user_id = u.user_id
WHERE n.message LIKE 'Low stock alert: Pantoprazole%';

UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = @new_presc_id;

SELECT 'AFTER dispensing: stock decremented 25 -> 15, AND an alert now exists' AS step;
SELECT stock_qty FROM MEDICINE WHERE medicine_id = 7;
SELECT n.notification_id, u.name, n.message FROM NOTIFICATION n JOIN `USER` u ON n.user_id = u.user_id
WHERE n.message LIKE 'Low stock alert: Pantoprazole%';

-- sanity check: re-dispensing an already-Dispensed prescription must NOT double-decrement
UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = @new_presc_id;
SELECT 'Stock unchanged on a repeat "dispense" of the same prescription (still 15)' AS step;
SELECT stock_qty FROM MEDICINE WHERE medicine_id = 7;

-- sanity check: trg_update_stock refuses to dispense when stock is insufficient
-- (prescription 4 needs 60 units of Metformin; before DEMO 1's restock it only had 15)
-- Uncomment to see it fail on the ORIGINAL (pre-restock) data:
-- UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = 4;
-- -> ERROR 1644 (45000): Cannot dispense: insufficient stock for one or more medicines...

-- ---------------------------------------------------------------
-- DEMO 4: trg_bill_autocalc (insert/update/delete)
-- ---------------------------------------------------------------
INSERT INTO BILL (patient_id, appointment_id, total_amount, payment_status, generated_by)
VALUES (7, NULL, 0, 'Unpaid', 14);
SET @new_bill_id = LAST_INSERT_ID();

SELECT 'BEFORE items: total_amount starts at 0' AS step;
SELECT bill_id, total_amount FROM BILL WHERE bill_id = @new_bill_id;

INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (@new_bill_id, 'Lab', 'CBC', 350.00);
INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (@new_bill_id, 'Medicine', 'Paracetamol', 50.00);

SELECT 'AFTER two inserts: total_amount auto-recalculated to 400' AS step;
SELECT bill_id, total_amount FROM BILL WHERE bill_id = @new_bill_id;

DELETE FROM BILL_ITEM WHERE bill_id = @new_bill_id AND item_type = 'Medicine';

SELECT 'AFTER deleting one item: total_amount auto-drops to 350' AS step;
SELECT bill_id, total_amount FROM BILL WHERE bill_id = @new_bill_id;

-- ---------------------------------------------------------------
-- DEMO 5: trg_block_patient_delete
-- ---------------------------------------------------------------
-- Vikram Chauhan (patient_id 9) has an Unpaid bill -> this must fail:
-- DELETE FROM PATIENT WHERE patient_id = 9;
-- -> ERROR 1644 (45000): Cannot delete patient: unpaid or partial bills exist

-- A patient with no bills at all can still be deleted (create + drop a throwaway one to prove it):
INSERT INTO `USER` (name, email, password_hash, phone, role_id)
VALUES ('Test Delete', 'test.delete@example.com', 'hash_x', '9000000001', 3);
SET @test_uid = LAST_INSERT_ID();
INSERT INTO PATIENT (patient_id, gender) VALUES (@test_uid, 'M');

SELECT 'Deleting a patient with zero bills succeeds (trigger only blocks unpaid ones)' AS step;
DELETE FROM PATIENT WHERE patient_id = @test_uid;
DELETE FROM `USER` WHERE user_id = @test_uid;

-- ---------------------------------------------------------------
-- DEMO 6: sp_book_appointment
-- ---------------------------------------------------------------
CALL sp_book_appointment(8, 3, 2, '2026-09-22', '14:00:00', 14);
SELECT 'New appointment booked via procedure' AS step;
SELECT appointment_id, patient_id, doctor_id, appointment_date, appointment_time, status
FROM APPOINTMENT WHERE patient_id = 8 AND appointment_date = '2026-09-22';

-- booking the exact same doctor/date/time again must be rejected:
-- CALL sp_book_appointment(5, 3, 2, '2026-09-22', '14:00:00', 14);
-- -> ERROR 1644 (45000): Selected slot is already booked for this doctor

-- ---------------------------------------------------------------
-- DEMO 7: sp_generate_bill -- end-to-end: the Demo-2 appointment gets a
-- consultation + a lab request, marked Completed, then billed automatically.
-- ---------------------------------------------------------------
UPDATE APPOINTMENT SET status = 'Completed' WHERE appointment_id = @demo_appt_id;

INSERT INTO CONSULTATION (appointment_id, symptoms, diagnosis, notes)
VALUES (@demo_appt_id, 'Follow-up review', 'Stable, no new findings', 'Continue current plan');
SET @demo_consult_id = LAST_INSERT_ID();

INSERT INTO LAB_REQUEST (consultation_id, test_id, requested_by, status)
VALUES (@demo_consult_id, 4, 4, 'Completed');  -- Blood Sugar Fasting, requested by Dr. Iyer

CALL sp_generate_bill(@demo_appt_id, 14);

SELECT 'Auto-generated bill: consultation fee + the lab test above, itemized' AS step;
SELECT bi.bill_id, bi.item_type, bi.description, bi.amount
FROM BILL_ITEM bi WHERE bi.bill_id = (SELECT MAX(bill_id) FROM BILL);
SELECT bill_id, total_amount FROM BILL WHERE bill_id = (SELECT MAX(bill_id) FROM BILL);
