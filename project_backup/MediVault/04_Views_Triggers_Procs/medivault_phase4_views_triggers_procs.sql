-- ============================================================
-- MediVault -- Phase 4: VIEWS + TRIGGERS + STORED PROCEDURES
-- Run after Phase 2 + the Phase 3 supplement are loaded.
-- For a live demo that exercises these (inserts test rows, dispenses
-- a prescription, etc.), run medivault_phase4_demo.sql separately AFTER
-- this file -- keeping the two apart means loading your schema objects
-- never silently mutates your data.
-- ============================================================

-- =====================================================================
-- EXPERIMENT 7 -- VIEWS
-- Demonstrates creation and usage of database views for role-based access
-- =====================================================================
-- Each view exists so a role's dashboard queries ONE object instead of
-- re-deriving the same joins everywhere, and so the app layer can grant
-- SELECT on the view without granting raw table access to sensitive columns
-- (e.g. a doctor's dashboard never needs direct access to BILL or PATIENT.address).
-- =====================================================================
USE medivault;

-- 1. Doctor dashboard: today's schedule
CREATE OR REPLACE VIEW vw_doctor_today_schedule AS
SELECT a.appointment_id, doc.doctor_id, ud.name AS doctor_name,
       up.name AS patient_name, a.patient_id, a.appointment_time, a.status
FROM APPOINTMENT a
JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id JOIN `USER` ud ON doc.doctor_id = ud.user_id
JOIN PATIENT p ON a.patient_id = p.patient_id JOIN `USER` up ON p.patient_id = up.user_id
WHERE a.appointment_date = CURDATE();

-- 2. Patient portal: one summary row per patient (next visit, records, pending bills, unread alerts)
CREATE OR REPLACE VIEW vw_patient_portal_summary AS
SELECT p.patient_id, u.name AS patient_name,
    (SELECT MIN(a.appointment_date) FROM APPOINTMENT a
       WHERE a.patient_id = p.patient_id AND a.status = 'Scheduled' AND a.appointment_date >= CURDATE()
    ) AS next_appointment_date,
    (SELECT COUNT(*) FROM MEDICAL_RECORD mr WHERE mr.patient_id = p.patient_id) AS record_count,
    (SELECT COUNT(*) FROM BILL b WHERE b.patient_id = p.patient_id AND b.payment_status <> 'Paid') AS pending_bills,
    (SELECT COUNT(*) FROM NOTIFICATION n WHERE n.user_id = p.patient_id AND n.is_read = FALSE) AS unread_notifications
FROM PATIENT p JOIN `USER` u ON p.patient_id = u.user_id;

-- 3. Pharmacist dashboard: medicines that need reordering
-- (single-table, no aggregation/DISTINCT/UNION -> this is the one we UPDATE through, below)
CREATE OR REPLACE VIEW vw_pharmacy_low_stock AS
SELECT medicine_id, medicine_name, stock_qty, unit_price, expiry_date
FROM MEDICINE
WHERE stock_qty < 20;

-- 4. Admin dashboard: revenue trend
CREATE OR REPLACE VIEW vw_monthly_revenue AS
SELECT DATE_FORMAT(bill_date, '%Y-%m') AS month, SUM(total_amount) AS revenue, COUNT(*) AS bill_count
FROM BILL
GROUP BY DATE_FORMAT(bill_date, '%Y-%m');

-- 5. Admin / Nurse dashboard: bed occupancy by ward
CREATE OR REPLACE VIEW vw_bed_occupancy AS
SELECT ward_name,
       SUM(status = 'Occupied') AS occupied,
       COUNT(*) AS total_beds,
       ROUND(100 * SUM(status = 'Occupied') / COUNT(*), 1) AS occupancy_pct
FROM BED
GROUP BY ward_name;

-- 6. Receptionist dashboard: front-desk snapshot, one row
CREATE OR REPLACE VIEW vw_reception_dashboard AS
SELECT
    (SELECT COUNT(*) FROM APPOINTMENT WHERE appointment_date = CURDATE()) AS todays_appointments,
    (SELECT COUNT(*) FROM BED WHERE status = 'Available') AS available_beds,
    (SELECT COUNT(*) FROM BILL WHERE payment_status <> 'Paid') AS pending_bills,
    (SELECT COUNT(*) FROM PATIENT) AS total_registered_patients;

-- ---- Read the views (this is what each role's dashboard actually calls) ----
SELECT * FROM vw_doctor_today_schedule;
SELECT * FROM vw_patient_portal_summary;
SELECT * FROM vw_pharmacy_low_stock;
SELECT * FROM vw_monthly_revenue;
SELECT * FROM vw_bed_occupancy;
SELECT * FROM vw_reception_dashboard;

-- =====================================================================
-- EXPERIMENT 8 -- TRIGGERS
-- Demonstrates BEFORE/AFTER triggers for automated business logic
-- =====================================================================
USE medivault;

DELIMITER $$

-- 1. Decrement stock when a prescription is marked Dispensed.
--    Guards against double-decrementing (fires only on Pending/other -> Dispensed),
--    and refuses the dispense outright if any item doesn't have enough stock,
--    instead of silently driving stock_qty negative (the CHECK constraint would
--    catch that too, but SIGNAL gives the pharmacist a readable reason).
CREATE TRIGGER trg_update_stock
BEFORE UPDATE ON PRESCRIPTION
FOR EACH ROW
BEGIN
    DECLARE insufficient_count INT DEFAULT 0;
    IF NEW.status = 'Dispensed' AND OLD.status <> 'Dispensed' THEN
        SELECT COUNT(*) INTO insufficient_count
        FROM (SELECT medicine_id, SUM(quantity) AS required_qty FROM PRESCRIPTION_ITEM
              WHERE prescription_id=NEW.prescription_id GROUP BY medicine_id) pi
        JOIN MEDICINE m ON pi.medicine_id = m.medicine_id
        WHERE m.stock_qty < pi.required_qty;

        IF insufficient_count > 0 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot dispense: insufficient stock for one or more medicines in this prescription';
        END IF;

        UPDATE MEDICINE m
        JOIN (SELECT medicine_id, SUM(quantity) AS required_qty FROM PRESCRIPTION_ITEM
              WHERE prescription_id=NEW.prescription_id GROUP BY medicine_id) pi
          ON m.medicine_id = pi.medicine_id
        SET m.stock_qty = m.stock_qty - pi.required_qty;
    END IF;
END$$

-- 2. Alert Admin + Pharmacists the moment a medicine's stock CROSSES below 20
--    (fires once per crossing, not on every update while it stays low --
--    otherwise every dispense of an already-low medicine would spam alerts).
--    Note: trigger #1 above updates MEDICINE, which fires this trigger too --
--    MySQL/MariaDB chain triggers across tables by default, no extra code needed.
CREATE TRIGGER trg_low_stock_alert
AFTER UPDATE ON MEDICINE
FOR EACH ROW
BEGIN
    IF NEW.stock_qty < 20 AND OLD.stock_qty >= 20 THEN
        INSERT INTO NOTIFICATION (user_id, message)
        SELECT u.user_id,
               CONCAT('Low stock alert: ', NEW.medicine_name, ' has only ', NEW.stock_qty, ' units left')
        FROM `USER` u JOIN ROLE r ON u.role_id = r.role_id
        WHERE r.role_name IN ('Admin', 'Pharmacist');
    END IF;
END$$

-- 3. Notify the patient the moment their appointment is booked.
CREATE TRIGGER trg_appointment_notification
AFTER INSERT ON APPOINTMENT
FOR EACH ROW
BEGIN
    INSERT INTO NOTIFICATION (user_id, message)
    VALUES (NEW.patient_id,
            CONCAT('Your appointment is booked for ', NEW.appointment_date, ' at ', NEW.appointment_time));
END$$

-- 4a-4c. Keep BILL.total_amount in sync with its BILL_ITEM rows on insert, edit, or removal
--        (the spec only asks for AFTER INSERT, but a bill that can't handle a corrected
--        or removed line item would drift from reality, so all three are included).
CREATE TRIGGER trg_bill_autocalc_insert
AFTER INSERT ON BILL_ITEM
FOR EACH ROW
BEGIN
    UPDATE BILL SET total_amount = (SELECT COALESCE(SUM(amount), 0) FROM BILL_ITEM WHERE bill_id = NEW.bill_id)
    WHERE bill_id = NEW.bill_id;
END$$

CREATE TRIGGER trg_bill_autocalc_update
AFTER UPDATE ON BILL_ITEM
FOR EACH ROW
BEGIN
    UPDATE BILL SET total_amount = (SELECT COALESCE(SUM(amount), 0) FROM BILL_ITEM WHERE bill_id = NEW.bill_id)
    WHERE bill_id = NEW.bill_id;
END$$

CREATE TRIGGER trg_bill_autocalc_delete
AFTER DELETE ON BILL_ITEM
FOR EACH ROW
BEGIN
    UPDATE BILL SET total_amount = (SELECT COALESCE(SUM(amount), 0) FROM BILL_ITEM WHERE bill_id = OLD.bill_id)
    WHERE bill_id = OLD.bill_id;
END$$

-- 5. Refuse to delete a patient who still owes money -- prevents orphaned billing data.
CREATE TRIGGER trg_block_patient_delete
BEFORE DELETE ON PATIENT
FOR EACH ROW
BEGIN
    DECLARE unpaid_count INT DEFAULT 0;
    SELECT COUNT(*) INTO unpaid_count FROM BILL
    WHERE patient_id = OLD.patient_id AND payment_status <> 'Paid';

    IF unpaid_count > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot delete patient: unpaid or partial bills exist';
    END IF;
END$$

DELIMITER ;

-- =====================================================================
-- BONUS -- STORED PROCEDURES (transactional logic)
-- NOT required by syllabus Experiments 7-8, included for completeness
-- =====================================================================
USE medivault;

DELIMITER $$

-- sp_book_appointment: checks the doctor's slot is free, then books it.
-- Wrapped in an explicit transaction with a handler that rolls back and
-- re-raises on any SQL error, so a failed insert never leaves a half-committed state.
CREATE PROCEDURE sp_book_appointment(
    IN p_patient_id INT, IN p_doctor_id INT, IN p_department_id INT,
    IN p_date DATE, IN p_time TIME, IN p_booked_by INT
)
BEGIN
    DECLARE slot_taken INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    START TRANSACTION;

    SELECT COUNT(*) INTO slot_taken FROM APPOINTMENT
    WHERE doctor_id = p_doctor_id AND appointment_date = p_date AND appointment_time = p_time
      AND status = 'Scheduled';

    IF slot_taken > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Selected slot is already booked for this doctor';
    END IF;

    INSERT INTO APPOINTMENT (patient_id, doctor_id, department_id, appointment_date, appointment_time, status, booked_by)
    VALUES (p_patient_id, p_doctor_id, p_department_id, p_date, p_time, 'Scheduled', p_booked_by);

    COMMIT;
END$$

-- sp_generate_bill: rolls a completed visit's consultation fee + any lab tests +
-- any prescribed medicines into one BILL with itemized BILL_ITEM rows.
-- Note: it never computes total_amount itself -- trg_bill_autocalc_insert does
-- that automatically as each BILL_ITEM row lands, which is why total_amount
-- starts at 0 here and is correct by the time COMMIT runs.
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
    FROM APPOINTMENT WHERE appointment_id = p_appointment_id;

    SELECT consultation_id INTO v_consultation_id
    FROM CONSULTATION WHERE appointment_id = p_appointment_id;

    IF v_consultation_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No consultation on record for this appointment yet';
    END IF;

    SELECT consultation_fee INTO v_fee FROM DOCTOR WHERE doctor_id = v_doctor_id;

    INSERT INTO BILL (patient_id, appointment_id, total_amount, payment_status, generated_by)
    VALUES (v_patient_id, p_appointment_id, 0, 'Unpaid', p_generated_by);
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
