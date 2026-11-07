-- ============================================================
-- MediVault -- Phase 4: VIEWS + TRIGGERS + STORED PROCEDURES (3NF)
-- Compatible with canonical db/schema.sql + db/seed.sql
-- ============================================================

USE medivault;

-- =====================================================================
-- EXPERIMENT 7 -- VIEWS
-- =====================================================================

-- 1. Doctor dashboard: today's schedule
CREATE OR REPLACE VIEW vw_doctor_today_schedule AS
SELECT a.appointment_id, doc.doctor_id, ud.name AS doctor_name,
       up.name AS patient_name, a.patient_id, a.appointment_time, a.status
FROM APPOINTMENT a
JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id JOIN `USER` ud ON doc.doctor_id = ud.user_id
JOIN PATIENT p ON a.patient_id = p.patient_id JOIN `USER` up ON p.patient_id = up.user_id
WHERE a.appointment_date = CURDATE();

-- 2. Patient portal summary
CREATE OR REPLACE VIEW vw_patient_portal_summary AS
SELECT p.patient_id, u.name AS patient_name,
    (SELECT MIN(a.appointment_date) FROM APPOINTMENT a
       WHERE a.patient_id = p.patient_id AND a.status IN ('Scheduled','Confirmed') AND a.appointment_date >= CURDATE()
    ) AS next_appointment_date,
    (SELECT COUNT(*) FROM MEDICAL_RECORD mr WHERE mr.patient_id = p.patient_id) AS record_count,
    (SELECT COUNT(*) FROM vw_bill_summary b WHERE b.patient_id = p.patient_id AND b.payment_status <> 'Paid') AS pending_bills,
    (SELECT COUNT(*) FROM NOTIFICATION n WHERE n.user_id = p.patient_id AND n.is_read = FALSE) AS unread_notifications
FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id;

-- 3. Pharmacist dashboard: medicines that need reordering (stock_qty < 20)
CREATE OR REPLACE VIEW vw_pharmacy_low_stock AS
SELECT medicine_id, medicine_name, stock_qty, unit_price, expiry_date
FROM vw_medicine_inventory
WHERE stock_qty < 20;

-- 4. Admin dashboard: revenue trend
CREATE OR REPLACE VIEW vw_monthly_revenue AS
SELECT DATE_FORMAT(bill_date, '%Y-%m') AS month, SUM(total_amount) AS revenue, COUNT(*) AS bill_count
FROM vw_bill_summary
GROUP BY DATE_FORMAT(bill_date, '%Y-%m');

-- 5. Admin / Nurse dashboard: bed occupancy by ward
CREATE OR REPLACE VIEW vw_bed_occupancy AS
SELECT w.ward_name,
       SUM(b.status = 'Occupied') AS occupied,
       COUNT(b.bed_id) AS total_beds,
       ROUND(100 * SUM(b.status = 'Occupied') / COUNT(b.bed_id), 1) AS occupancy_pct
FROM WARD w
JOIN BED b ON w.ward_id = b.ward_id
GROUP BY w.ward_id, w.ward_name;

-- 6. Receptionist dashboard snapshot
CREATE OR REPLACE VIEW vw_reception_dashboard AS
SELECT
    (SELECT COUNT(*) FROM APPOINTMENT WHERE appointment_date = CURDATE()) AS todays_appointments,
    (SELECT COUNT(*) FROM BED WHERE status = 'Available') AS available_beds,
    (SELECT COUNT(*) FROM vw_bill_summary WHERE payment_status <> 'Paid') AS pending_bills,
    (SELECT COUNT(*) FROM PATIENT) AS total_registered_patients;

-- ---- Read the views ----
SELECT * FROM vw_doctor_today_schedule;
SELECT * FROM vw_patient_portal_summary;
SELECT * FROM vw_pharmacy_low_stock;
SELECT * FROM vw_monthly_revenue;
SELECT * FROM vw_bed_occupancy;
SELECT * FROM vw_reception_dashboard;

-- =====================================================================
-- EXPERIMENT 8 -- TRIGGERS
-- =====================================================================

DROP TRIGGER IF EXISTS trg_update_stock;
DROP TRIGGER IF EXISTS trg_low_stock_alert;
DROP TRIGGER IF EXISTS trg_appointment_notification;
DROP TRIGGER IF EXISTS trg_block_patient_delete;

DELIMITER $$

-- 1. Decrement batch stock (FEFO) when a prescription is marked Dispensed
CREATE TRIGGER trg_update_stock
BEFORE UPDATE ON PRESCRIPTION
FOR EACH ROW
BEGIN
    DECLARE done INT DEFAULT FALSE;
    DECLARE v_med_id INT;
    DECLARE v_req_qty INT;
    DECLARE v_avail_qty INT;
    DECLARE v_batch_id INT;
    DECLARE v_batch_qty INT;
    DECLARE v_deduct INT;
    DECLARE v_already_dispensed INT DEFAULT 0;

    DECLARE cur_items CURSOR FOR
        SELECT medicine_id, SUM(quantity) AS required_qty
        FROM PRESCRIPTION_ITEM
        WHERE prescription_id = NEW.prescription_id
        GROUP BY medicine_id;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    IF NEW.status = 'Dispensed' AND OLD.status <> 'Dispensed' THEN
        SELECT COUNT(*) INTO v_already_dispensed
        FROM DISPENSING_RECORD
        WHERE prescription_id = NEW.prescription_id;

        IF v_already_dispensed = 0 THEN
            OPEN cur_items;
            read_loop: LOOP
                FETCH cur_items INTO v_med_id, v_req_qty;
                IF done THEN
                    LEAVE read_loop;
                END IF;

                SELECT COALESCE(SUM(available_qty), 0) INTO v_avail_qty
                FROM MEDICINE_BATCH
                WHERE medicine_id = v_med_id AND expiry_date >= CURDATE();

                IF v_avail_qty < v_req_qty THEN
                    SIGNAL SQLSTATE '45000'
                    SET MESSAGE_TEXT = 'Cannot dispense: insufficient non-expired stock for one or more medicines in this prescription';
                END IF;

                WHILE v_req_qty > 0 DO
                    SELECT batch_id, available_qty INTO v_batch_id, v_batch_qty
                    FROM MEDICINE_BATCH
                    WHERE medicine_id = v_med_id AND available_qty > 0 AND expiry_date >= CURDATE()
                    ORDER BY expiry_date ASC, batch_id ASC
                    LIMIT 1;

                    SET v_deduct = LEAST(v_req_qty, v_batch_qty);
                    UPDATE MEDICINE_BATCH
                    SET available_qty = available_qty - v_deduct
                    WHERE batch_id = v_batch_id;

                    SET v_req_qty = v_req_qty - v_deduct;
                END WHILE;
            END LOOP;
            CLOSE cur_items;
        END IF;
    END IF;
END$$

-- 2. Alert Admin + Pharmacists when total non-expired stock crosses below 20
CREATE TRIGGER trg_low_stock_alert
AFTER UPDATE ON MEDICINE_BATCH
FOR EACH ROW
BEGIN
    DECLARE v_other_stock INT DEFAULT 0;
    DECLARE v_old_total INT DEFAULT 0;
    DECLARE v_new_total INT DEFAULT 0;
    DECLARE v_med_name VARCHAR(100);

    SELECT COALESCE(SUM(available_qty), 0) INTO v_other_stock
    FROM MEDICINE_BATCH
    WHERE medicine_id = NEW.medicine_id
      AND batch_id <> NEW.batch_id
      AND expiry_date >= CURDATE();

    SET v_old_total = v_other_stock + (CASE WHEN OLD.expiry_date >= CURDATE() THEN OLD.available_qty ELSE 0 END);
    SET v_new_total = v_other_stock + (CASE WHEN NEW.expiry_date >= CURDATE() THEN NEW.available_qty ELSE 0 END);

    IF v_new_total < 20 AND v_old_total >= 20 THEN
        SELECT medicine_name INTO v_med_name FROM MEDICINE WHERE medicine_id = NEW.medicine_id;
        INSERT INTO NOTIFICATION (user_id, message)
        SELECT u.user_id,
               CONCAT('Low stock alert: ', v_med_name, ' has only ', v_new_total, ' units left')
        FROM `USER` u JOIN ROLE r ON u.role_id = r.role_id
        WHERE r.role_name IN ('Admin', 'Pharmacist');
    END IF;
END$$

-- 3. Notify patient when their appointment is booked
CREATE TRIGGER trg_appointment_notification
AFTER INSERT ON APPOINTMENT
FOR EACH ROW
BEGIN
    INSERT INTO NOTIFICATION (user_id, message)
    VALUES (NEW.patient_id,
            CONCAT('Your appointment is booked for ', NEW.appointment_date, ' at ', NEW.appointment_time));
END$$

-- 4. Refuse to delete a patient who still owes money
CREATE TRIGGER trg_block_patient_delete
BEFORE DELETE ON PATIENT
FOR EACH ROW
BEGIN
    DECLARE unpaid_count INT DEFAULT 0;
    SELECT COUNT(*) INTO unpaid_count FROM vw_bill_summary
    WHERE patient_id = OLD.patient_id AND payment_status <> 'Paid';

    IF unpaid_count > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot delete patient: unpaid or partial bills exist';
    END IF;
END$$

DELIMITER ;

-- =====================================================================
-- BONUS -- STORED PROCEDURES
-- =====================================================================

DROP PROCEDURE IF EXISTS sp_book_appointment;
DROP PROCEDURE IF EXISTS sp_generate_bill;

DELIMITER $$

CREATE PROCEDURE sp_book_appointment(
    IN p_patient_id INT, IN p_doctor_id INT, IN p_department_id INT,
    IN p_date DATE, IN p_time TIME, IN p_booked_by INT
)
BEGIN
    DECLARE slot_taken INT DEFAULT 0;
    DECLARE v_doc_dept INT DEFAULT NULL;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    SELECT department_id INTO v_doc_dept
    FROM DOCTOR WHERE doctor_id = p_doctor_id FOR UPDATE;

    IF v_doc_dept IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Selected doctor does not exist';
    END IF;

    SELECT COUNT(*) INTO slot_taken FROM APPOINTMENT
    WHERE doctor_id = p_doctor_id AND appointment_date = p_date AND appointment_time = p_time
      AND status IN ('Scheduled', 'Confirmed', 'Checked In')
    FOR UPDATE;

    IF slot_taken > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Selected slot is already booked for this doctor';
    END IF;

    INSERT INTO APPOINTMENT (patient_id, doctor_id, appointment_date, appointment_time, status, booked_by)
    VALUES (p_patient_id, p_doctor_id, p_date, p_time, 'Scheduled', p_booked_by);

    COMMIT;
END$$

CREATE PROCEDURE sp_generate_bill(IN p_appointment_id INT, IN p_generated_by INT)
BEGIN
    DECLARE v_patient_id INT;
    DECLARE v_doctor_id INT;
    DECLARE v_consultation_id INT;
    DECLARE v_fee DECIMAL(8,2);
    DECLARE v_bill_id INT;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    SELECT patient_id, doctor_id INTO v_patient_id, v_doctor_id
    FROM APPOINTMENT WHERE appointment_id = p_appointment_id FOR UPDATE;

    SELECT consultation_id INTO v_consultation_id
    FROM CONSULTATION WHERE appointment_id = p_appointment_id;

    IF v_consultation_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No consultation on record for this appointment yet';
    END IF;

    SELECT consultation_fee INTO v_fee FROM DOCTOR WHERE doctor_id = v_doctor_id;

    INSERT INTO BILL (patient_id, appointment_id, generated_by)
    VALUES (v_patient_id, p_appointment_id, p_generated_by);
    SET v_bill_id = LAST_INSERT_ID();

    INSERT INTO BILL_ITEM (bill_id, item_type, description, amount)
    VALUES (v_bill_id, 'Consultation', 'Doctor consultation fee', v_fee);

    INSERT INTO BILL_ITEM (bill_id, item_type, description, amount)
    SELECT v_bill_id, 'Lab', lt.test_name, lt.price
    FROM LAB_REQUEST lr JOIN LAB_TEST lt ON lr.test_id = lt.test_id
    WHERE lr.consultation_id = v_consultation_id;

    INSERT INTO BILL_ITEM (bill_id, item_type, description, amount)
    SELECT v_bill_id, 'Medicine', m.medicine_name, m.unit_price * pi.quantity
    FROM PRESCRIPTION pr JOIN PRESCRIPTION_ITEM pi ON pr.prescription_id = pi.prescription_id
    JOIN MEDICINE m ON pi.medicine_id = m.medicine_id
    WHERE pr.consultation_id = v_consultation_id;

    COMMIT;
END$$

DELIMITER ;
