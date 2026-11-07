-- ============================================================
-- MediVault -- Phase 4 DEMO (Normalized 3NF Schema)
-- Exercises every view/trigger/procedure against the live 3NF dataset
-- ============================================================
USE medivault;

-- ---------------------------------------------------------------
-- DEMO 1: low-stock view + restocking MEDICINE_BATCH
-- ---------------------------------------------------------------
SELECT 'BEFORE: low-stock list' AS step;
SELECT * FROM vw_pharmacy_low_stock;

UPDATE MEDICINE_BATCH SET available_qty = available_qty + 100 WHERE medicine_id = 5;

SELECT 'AFTER: MEDICINE_BATCH updated, reflected in vw_medicine_inventory' AS step;
SELECT medicine_id, medicine_name, stock_qty FROM vw_medicine_inventory WHERE medicine_id = 5;
SELECT 'AFTER: Metformin drops out of the low-stock view (no longer < 20)' AS step;
SELECT * FROM vw_pharmacy_low_stock;

-- ---------------------------------------------------------------
-- DEMO 2: trg_appointment_notification
-- ---------------------------------------------------------------
SELECT 'BEFORE: notifications for patient 7' AS step;
SELECT * FROM NOTIFICATION WHERE user_id = 7;

INSERT INTO APPOINTMENT (patient_id, doctor_id, appointment_date, appointment_time, status, booked_by)
VALUES (7, 4, '2026-09-20', '11:00:00', 'Scheduled', 14);
SET @demo_appt_id = LAST_INSERT_ID();

SELECT 'AFTER: a notification appeared automatically' AS step;
SELECT * FROM NOTIFICATION WHERE user_id = 7;

-- ---------------------------------------------------------------
-- DEMO 3: trg_update_stock -> chains into trg_low_stock_alert
-- ---------------------------------------------------------------
UPDATE MEDICINE_BATCH SET available_qty = 25 WHERE medicine_id = 7;

INSERT INTO PRESCRIPTION (consultation_id, status)
VALUES (2, 'Pending');
SET @new_presc_id = LAST_INSERT_ID();

INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, duration_days, quantity)
VALUES (@new_presc_id, 7, '1-0-1', 5, 10);

SELECT 'BEFORE dispensing: Pantoprazole stock, and any Admin/Pharmacist low-stock alerts' AS step;
SELECT stock_qty FROM vw_medicine_inventory WHERE medicine_id = 7;
SELECT n.notification_id, u.name, n.message FROM NOTIFICATION n JOIN `USER` u ON n.user_id = u.user_id
WHERE n.message LIKE 'Low stock alert: Pantoprazole%';

UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = @new_presc_id;

SELECT 'AFTER dispensing: stock decremented 25 -> 15, AND an alert now exists' AS step;
SELECT stock_qty FROM vw_medicine_inventory WHERE medicine_id = 7;
SELECT n.notification_id, u.name, n.message FROM NOTIFICATION n JOIN `USER` u ON n.user_id = u.user_id
WHERE n.message LIKE 'Low stock alert: Pantoprazole%';

-- sanity check: re-dispensing an already-Dispensed prescription must NOT double-decrement
UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = @new_presc_id;
SELECT 'Stock unchanged on repeat dispense (still 15)' AS step;
SELECT stock_qty FROM vw_medicine_inventory WHERE medicine_id = 7;

-- ---------------------------------------------------------------
-- DEMO 4: vw_bill_summary (computed total_amount & payment_status)
-- ---------------------------------------------------------------
INSERT INTO BILL (patient_id, appointment_id, generated_by)
VALUES (7, NULL, 14);
SET @new_bill_id = LAST_INSERT_ID();

SELECT 'BEFORE items: total_amount starts at 0' AS step;
SELECT bill_id, total_amount, payment_status FROM vw_bill_summary WHERE bill_id = @new_bill_id;

INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (@new_bill_id, 'Lab', 'CBC', 350.00);
INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES (@new_bill_id, 'Medicine', 'Paracetamol', 50.00);

SELECT 'AFTER two inserts: total_amount computed as 400' AS step;
SELECT bill_id, total_amount, payment_status FROM vw_bill_summary WHERE bill_id = @new_bill_id;

DELETE FROM BILL_ITEM WHERE bill_id = @new_bill_id AND item_type = 'Medicine';

SELECT 'AFTER deleting one item: total_amount drops to 350' AS step;
SELECT bill_id, total_amount, payment_status FROM vw_bill_summary WHERE bill_id = @new_bill_id;

-- ---------------------------------------------------------------
-- DEMO 5: trg_block_patient_delete
-- ---------------------------------------------------------------
INSERT INTO `USER` (name, email, password_hash, phone, role_id)
VALUES ('Test Delete', 'test.delete@example.com', '$2a$10$v1L1KWnJoT52YPFjadbqQOYeEifxGzBaQwu45Y97whb1IOS7r57cW', '9000000001', 3);
SET @test_uid = LAST_INSERT_ID();
INSERT INTO PATIENT (patient_id, gender) VALUES (@test_uid, 'M');

SELECT 'Deleting a patient with zero bills succeeds' AS step;
DELETE FROM PATIENT WHERE patient_id = @test_uid;
DELETE FROM `USER` WHERE user_id = @test_uid;

-- ---------------------------------------------------------------
-- DEMO 6: sp_book_appointment
-- ---------------------------------------------------------------
CALL sp_book_appointment(8, 3, 2, '2026-09-22', '14:00:00', 14);
SELECT 'New appointment booked via procedure' AS step;
SELECT appointment_id, patient_id, doctor_id, appointment_date, appointment_time, status
FROM APPOINTMENT WHERE patient_id = 8 AND appointment_date = '2026-09-22';

-- ---------------------------------------------------------------
-- DEMO 7: sp_generate_bill
-- ---------------------------------------------------------------
UPDATE APPOINTMENT SET status = 'Completed' WHERE appointment_id = @demo_appt_id;

INSERT INTO CONSULTATION (appointment_id, symptoms, diagnosis, notes)
VALUES (@demo_appt_id, 'Follow-up review', 'Stable, no new findings', 'Continue current plan');
SET @demo_consult_id = LAST_INSERT_ID();

INSERT INTO LAB_REQUEST (consultation_id, test_id, requested_by, status)
VALUES (@demo_consult_id, 4, 4, 'Completed');

CALL sp_generate_bill(@demo_appt_id, 14);

SELECT 'Auto-generated bill: consultation fee + lab test above, itemized' AS step;
SELECT bi.bill_id, bi.item_type, bi.description, bi.amount
FROM BILL_ITEM bi WHERE bi.bill_id = (SELECT MAX(bill_id) FROM BILL);
SELECT bill_id, total_amount, payment_status FROM vw_bill_summary WHERE bill_id = (SELECT MAX(bill_id) FROM BILL);
