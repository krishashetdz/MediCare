-- ============================================================
-- MediVault -- Phase 2: DDL + DML
-- MySQL 8.0 / MariaDB 10.2+ compatible
-- Tested end-to-end against a live MySQL-compatible server: all 21
-- tables, all CHECK/FK constraints, ALTER/TRUNCATE/DROP verified.
-- ============================================================

-- =====================================================================
-- EXPERIMENT 1 -- STUDY OF DDL STATEMENTS
-- Covers: CREATE DATABASE, CREATE TABLE, ALTER TABLE, TRUNCATE, DROP
-- =====================================================================

DROP DATABASE IF EXISTS medivault;
CREATE DATABASE medivault;
USE medivault;

-- ================= PART A: DDL (schema + all constraints) =================

-- 1. ROLE
CREATE TABLE ROLE (
    role_id     INT AUTO_INCREMENT PRIMARY KEY,
    role_name   VARCHAR(30) NOT NULL UNIQUE
);

-- 2. USER  (backticked: reserved-adjacent name in MySQL)
CREATE TABLE `USER` (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(100) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    phone           VARCHAR(15),
    role_id         INT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES ROLE(role_id) ON DELETE RESTRICT
);

-- 3. DEPARTMENT  (hod_doctor_id FK added later - circular dependency with DOCTOR)
CREATE TABLE DEPARTMENT (
    department_id   INT AUTO_INCREMENT PRIMARY KEY,
    department_name VARCHAR(80) NOT NULL UNIQUE,
    floor_no        INT,
    hod_doctor_id   INT NULL
);

-- 4. DOCTOR (extends USER)
CREATE TABLE DOCTOR (
    doctor_id           INT PRIMARY KEY,
    department_id       INT NOT NULL,
    specialization      VARCHAR(80),
    qualification       VARCHAR(80),
    consultation_fee    DECIMAL(8,2) NOT NULL DEFAULT 0 CHECK (consultation_fee >= 0),
    experience_years    INT DEFAULT 0,
    CONSTRAINT fk_doctor_user FOREIGN KEY (doctor_id) REFERENCES `USER`(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_doctor_dept FOREIGN KEY (department_id) REFERENCES DEPARTMENT(department_id) ON DELETE RESTRICT
);

-- circular FK resolved now that DOCTOR exists
ALTER TABLE DEPARTMENT
    ADD CONSTRAINT fk_dept_hod FOREIGN KEY (hod_doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE SET NULL;

-- 5. PATIENT (extends USER)
CREATE TABLE PATIENT (
    patient_id          INT PRIMARY KEY,
    dob                 DATE,
    gender              CHAR(1) CHECK (gender IN ('M','F','O')),
    blood_group         VARCHAR(3),
    address             VARCHAR(200),
    emergency_contact   VARCHAR(15),
    CONSTRAINT fk_patient_user FOREIGN KEY (patient_id) REFERENCES `USER`(user_id) ON DELETE CASCADE
);

-- 6. STAFF (extends USER)
CREATE TABLE STAFF (
    staff_id        INT PRIMARY KEY,
    staff_type      ENUM('NURSE','LAB_TECHNICIAN','PHARMACIST','RECEPTIONIST') NOT NULL,
    department_id   INT NULL,
    shift           ENUM('Morning','Evening','Night'),
    CONSTRAINT fk_staff_user FOREIGN KEY (staff_id) REFERENCES `USER`(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_staff_dept FOREIGN KEY (department_id) REFERENCES DEPARTMENT(department_id) ON DELETE SET NULL
);

-- 7. APPOINTMENT
CREATE TABLE APPOINTMENT (
    appointment_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    doctor_id           INT NOT NULL,
    department_id       INT NOT NULL,
    appointment_date    DATE NOT NULL,
    appointment_time    TIME NOT NULL,
    status              VARCHAR(15) NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','Completed','Cancelled')),
    booked_by           INT,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_appt_doctor  FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE RESTRICT,
    CONSTRAINT fk_appt_dept    FOREIGN KEY (department_id) REFERENCES DEPARTMENT(department_id) ON DELETE RESTRICT,
    CONSTRAINT fk_appt_booker  FOREIGN KEY (booked_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
);

-- 8. MEDICAL_RECORD
CREATE TABLE MEDICAL_RECORD (
    record_id           INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    doctor_id           INT NOT NULL,
    diagnosis_summary   VARCHAR(500),
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mr_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_mr_doctor  FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE RESTRICT
);

-- 9. CONSULTATION
CREATE TABLE CONSULTATION (
    consultation_id     INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id      INT NOT NULL UNIQUE,
    symptoms            VARCHAR(300),
    diagnosis           VARCHAR(300),
    notes               VARCHAR(500),
    consultation_date   DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_consult_appt FOREIGN KEY (appointment_id) REFERENCES APPOINTMENT(appointment_id) ON DELETE CASCADE
);

-- 10. MEDICINE
CREATE TABLE MEDICINE (
    medicine_id     INT AUTO_INCREMENT PRIMARY KEY,
    medicine_name   VARCHAR(100) NOT NULL,
    manufacturer    VARCHAR(100),
    unit_price      DECIMAL(8,2) NOT NULL CHECK (unit_price >= 0),
    stock_qty       INT NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    expiry_date     DATE
);

-- 11. PRESCRIPTION
CREATE TABLE PRESCRIPTION (
    prescription_id     INT AUTO_INCREMENT PRIMARY KEY,
    consultation_id     INT NOT NULL,
    patient_id          INT NOT NULL,
    doctor_id           INT NOT NULL,
    prescribed_date     DATETIME DEFAULT CURRENT_TIMESTAMP,
    status              VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Dispensed')),
    CONSTRAINT fk_presc_consult FOREIGN KEY (consultation_id) REFERENCES CONSULTATION(consultation_id) ON DELETE CASCADE,
    CONSTRAINT fk_presc_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_presc_doctor  FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE RESTRICT
);

-- 12. PRESCRIPTION_ITEM
CREATE TABLE PRESCRIPTION_ITEM (
    item_id             INT AUTO_INCREMENT PRIMARY KEY,
    prescription_id     INT NOT NULL,
    medicine_id         INT NOT NULL,
    dosage              VARCHAR(30),
    duration_days       INT CHECK (duration_days > 0),
    quantity            INT NOT NULL CHECK (quantity > 0),
    CONSTRAINT fk_item_presc FOREIGN KEY (prescription_id) REFERENCES PRESCRIPTION(prescription_id) ON DELETE CASCADE,
    CONSTRAINT fk_item_med   FOREIGN KEY (medicine_id) REFERENCES MEDICINE(medicine_id) ON DELETE RESTRICT
);

-- 13. LAB_TEST
CREATE TABLE LAB_TEST (
    test_id         INT AUTO_INCREMENT PRIMARY KEY,
    test_name       VARCHAR(100) NOT NULL UNIQUE,
    test_category   VARCHAR(50),
    price           DECIMAL(8,2) NOT NULL CHECK (price >= 0)
);

-- 14. LAB_REQUEST
CREATE TABLE LAB_REQUEST (
    request_id      INT AUTO_INCREMENT PRIMARY KEY,
    consultation_id INT NOT NULL,
    test_id         INT NOT NULL,
    requested_by    INT NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed')),
    request_date    DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_labreq_consult FOREIGN KEY (consultation_id) REFERENCES CONSULTATION(consultation_id) ON DELETE CASCADE,
    CONSTRAINT fk_labreq_test    FOREIGN KEY (test_id) REFERENCES LAB_TEST(test_id) ON DELETE RESTRICT,
    CONSTRAINT fk_labreq_doctor  FOREIGN KEY (requested_by) REFERENCES DOCTOR(doctor_id) ON DELETE RESTRICT
);

-- 15. LAB_REPORT
CREATE TABLE LAB_REPORT (
    report_id       INT AUTO_INCREMENT PRIMARY KEY,
    request_id      INT NOT NULL UNIQUE,
    technician_id   INT NOT NULL,
    result_summary  VARCHAR(500),
    report_date     DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_report_req   FOREIGN KEY (request_id) REFERENCES LAB_REQUEST(request_id) ON DELETE CASCADE,
    CONSTRAINT fk_report_staff FOREIGN KEY (technician_id) REFERENCES STAFF(staff_id) ON DELETE RESTRICT
);

-- 16. BED
CREATE TABLE BED (
    bed_id      INT AUTO_INCREMENT PRIMARY KEY,
    ward_name   VARCHAR(50) NOT NULL,
    bed_number  VARCHAR(10) NOT NULL,
    status      VARCHAR(10) NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','Occupied')),
    patient_id  INT NULL,
    CONSTRAINT uq_ward_bed UNIQUE (ward_name, bed_number),
    CONSTRAINT fk_bed_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE SET NULL
);

-- 17. AMBULANCE
CREATE TABLE AMBULANCE (
    ambulance_id    INT AUTO_INCREMENT PRIMARY KEY,
    vehicle_number  VARCHAR(20) NOT NULL UNIQUE,
    driver_name     VARCHAR(100),
    driver_phone    VARCHAR(15),
    status          VARCHAR(10) NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','On Duty'))
);

-- 18. BLOOD_BANK
CREATE TABLE BLOOD_BANK (
    blood_id            INT AUTO_INCREMENT PRIMARY KEY,
    blood_group         VARCHAR(3) NOT NULL UNIQUE CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
    units_available     INT NOT NULL DEFAULT 0 CHECK (units_available >= 0),
    last_updated        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 19. BILL
CREATE TABLE BILL (
    bill_id         INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NOT NULL,
    appointment_id  INT NULL,
    total_amount    DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    payment_status  VARCHAR(10) NOT NULL DEFAULT 'Unpaid' CHECK (payment_status IN ('Paid','Unpaid','Partial')),
    bill_date       DATETIME DEFAULT CURRENT_TIMESTAMP,
    generated_by    INT,
    CONSTRAINT fk_bill_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bill_appt    FOREIGN KEY (appointment_id) REFERENCES APPOINTMENT(appointment_id) ON DELETE SET NULL,
    CONSTRAINT fk_bill_user    FOREIGN KEY (generated_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
);

-- 20. BILL_ITEM
CREATE TABLE BILL_ITEM (
    bill_item_id    INT AUTO_INCREMENT PRIMARY KEY,
    bill_id         INT NOT NULL,
    item_type       VARCHAR(15) NOT NULL CHECK (item_type IN ('Consultation','Lab','Medicine','Bed')),
    description     VARCHAR(200),
    amount          DECIMAL(8,2) NOT NULL CHECK (amount >= 0),
    CONSTRAINT fk_billitem_bill FOREIGN KEY (bill_id) REFERENCES BILL(bill_id) ON DELETE CASCADE
);

-- 21. NOTIFICATION
CREATE TABLE NOTIFICATION (
    notification_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NOT NULL,
    message         VARCHAR(300) NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES `USER`(user_id) ON DELETE CASCADE
);

-- 22. AUDIT_LOG
CREATE TABLE AUDIT_LOG (
    log_id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NULL,
    action          VARCHAR(200) NOT NULL,
    table_affected  VARCHAR(50) NOT NULL,
    timestamp       DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES `USER`(user_id) ON DELETE SET NULL
);
USE medivault;

-- =====================================================================
-- EXPERIMENT 2 -- STUDY OF DML STATEMENTS
-- Covers: INSERT, UPDATE, DELETE
-- =====================================================================

-- ================= PART B: DML (sample data, 21 tables, Indian names, INR amounts) =================

-- All monetary columns are DECIMAL and store amounts in ₹ (Indian Rupees); the symbol itself is not stored, only the numeric value.

-- ROLE
INSERT INTO ROLE (role_name) VALUES
('Admin'),('Doctor'),('Patient'),('Nurse'),('Lab Technician'),('Pharmacist'),('Receptionist');

-- USER  (1 Admin, 3 Doctors, 6 Patients, 4 Staff = 14 rows; USER is shared by every role so it naturally needs more than 5-8)
INSERT INTO `USER` (name, email, password_hash, phone, role_id) VALUES
('Rohan Kulkarni', 'admin@medivault.in', 'hash_admin1', '9800000001', 1),
('Dr. Aditi Sharma', 'sharma.doc@medivault.in', 'hash_doc1', '9800000002', 2),
('Dr. Karan Mehta', 'mehta.doc@medivault.in', 'hash_doc2', '9800000003', 2),
('Dr. Lakshmi Iyer', 'iyer.doc@medivault.in', 'hash_doc3', '9800000004', 2),
('Rahul Verma', 'rahul.verma@gmail.com', 'hash_pat1', '9811100001', 3),
('Priya Nair', 'priya.nair@gmail.com', 'hash_pat2', '9811100002', 3),
('Amit Deshmukh', 'amit.deshmukh@gmail.com', 'hash_pat3', '9811100003', 3),
('Sneha Reddy', 'sneha.reddy@gmail.com', 'hash_pat4', '9811100004', 3),
('Vikram Chauhan', 'vikram.chauhan@gmail.com', 'hash_pat5', '9811100005', 3),
('Anjali Bhatt', 'anjali.bhatt@gmail.com', 'hash_pat6', '9811100006', 3),
('Kavita Joshi', 'kavita.joshi@medivault.in', 'hash_staff1', '9822200001', 4),
('Arjun Pillai', 'arjun.pillai@medivault.in', 'hash_staff2', '9822200002', 5),
('Neha Kapoor', 'neha.kapoor@medivault.in', 'hash_staff3', '9822200003', 6),
('Suresh Rao', 'suresh.rao@medivault.in', 'hash_staff4', '9822200004', 7);

-- DEPARTMENT (hod_doctor_id filled in later once doctors exist)
INSERT INTO DEPARTMENT (department_name, floor_no) VALUES
('Cardiology', 2),
('Orthopedics', 3),
('General Medicine', 1),
('Pediatrics', 1),
('ENT', 2);

-- DOCTOR  (user_id 2,3,4)
INSERT INTO DOCTOR (doctor_id, department_id, specialization, qualification, consultation_fee, experience_years) VALUES
(2, 1, 'Cardiologist', 'MD Cardiology', 900.00, 12),
(3, 2, 'Orthopedic Surgeon', 'MS Ortho', 700.00, 8),
(4, 3, 'General Physician', 'MBBS, MD', 500.00, 6);

-- now assign heads of department (demonstrates the deferred circular FK)
UPDATE DEPARTMENT SET hod_doctor_id = 2 WHERE department_name = 'Cardiology';
UPDATE DEPARTMENT SET hod_doctor_id = 3 WHERE department_name = 'Orthopedics';
UPDATE DEPARTMENT SET hod_doctor_id = 4 WHERE department_name = 'General Medicine';

-- PATIENT (user_id 5-10)
INSERT INTO PATIENT (patient_id, dob, gender, blood_group, address, emergency_contact) VALUES
(5, '1990-04-12', 'M', 'B+', 'Kothrud, Pune', '9900011111'),
(6, '1995-08-23', 'F', 'O+', 'Andheri, Mumbai', '9900022222'),
(7, '1988-01-30', 'M', 'A+', 'Koramangala, Bengaluru', '9900033333'),
(8, '2001-11-05', 'F', 'AB-', 'Banjara Hills, Hyderabad', '9900044444'),
(9, '1979-06-18', 'M', 'O-', 'Salt Lake, Kolkata', '9900055555'),
(10, '1998-03-27', 'F', 'B-', 'Vastrapur, Ahmedabad', '9900066666');

-- STAFF (user_id 11-14)
INSERT INTO STAFF (staff_id, staff_type, department_id, shift) VALUES
(11, 'NURSE', 1, 'Morning'),
(12, 'LAB_TECHNICIAN', 3, 'Morning'),
(13, 'PHARMACIST', NULL, 'Evening'),
(14, 'RECEPTIONIST', NULL, 'Morning');

-- APPOINTMENT
INSERT INTO APPOINTMENT (patient_id, doctor_id, department_id, appointment_date, appointment_time, status, booked_by) VALUES
(5, 2, 1, '2026-09-10', '09:30:00', 'Completed', 14),
(6, 3, 2, '2026-09-10', '10:00:00', 'Completed', 14),
(7, 4, 3, '2026-09-11', '11:15:00', 'Completed', 7),
(8, 2, 1, '2026-09-12', '09:00:00', 'Scheduled', 14),
(9, 4, 3, '2026-09-12', '12:00:00', 'Completed', 9),
(10, 3, 2, '2026-09-13', '15:30:00', 'Cancelled', 14),
(5, 4, 3, '2026-09-15', '16:00:00', 'Scheduled', 5),
(6, 2, 1, '2026-09-16', '09:45:00', 'Scheduled', 14);

-- MEDICAL_RECORD
INSERT INTO MEDICAL_RECORD (patient_id, doctor_id, diagnosis_summary) VALUES
(5, 2, 'Mild hypertension, advised lifestyle changes'),
(6, 3, 'Fractured wrist, cast applied'),
(7, 4, 'Seasonal viral fever'),
(8, 2, 'Routine cardiac checkup, normal ECG'),
(9, 4, 'Type 2 diabetes follow-up'),
(10, 3, 'Lower back pain, physiotherapy advised');

-- CONSULTATION (linked 1:1 to completed appointments)
INSERT INTO CONSULTATION (appointment_id, symptoms, diagnosis, notes) VALUES
(1, 'Chest tightness, fatigue', 'Mild hypertension', 'Start on low-dose medication, review in 2 weeks'),
(2, 'Wrist pain after fall', 'Distal radius fracture', 'Cast for 4 weeks, follow-up X-ray'),
(3, 'Fever, body ache', 'Seasonal viral fever', 'Rest, fluids, antipyretics'),
(5, 'Occasional dizziness', 'Uncontrolled sugar levels', 'Adjust metformin dosage');

-- MEDICINE
INSERT INTO MEDICINE (medicine_name, manufacturer, unit_price, stock_qty, expiry_date) VALUES
('Paracetamol 500mg', 'Cipla', 2.50, 500, '2027-06-30'),
('Amoxicillin 250mg', 'Sun Pharma', 6.00, 300, '2027-01-31'),
('Cetirizine 10mg', 'Dr. Reddys', 1.80, 400, '2027-09-30'),
('Ibuprofen 400mg', 'Cipla', 3.20, 250, '2026-12-31'),
('Metformin 500mg', 'Sun Pharma', 2.10, 15, '2027-03-31'),
('Azithromycin 500mg', 'Alkem', 12.00, 120, '2026-11-30'),
('Pantoprazole 40mg', 'Dr. Reddys', 4.50, 200, '2027-05-31'),
('Vitamin D3 60K IU', 'Mankind', 8.00, 350, '2027-08-31');

-- PRESCRIPTION
INSERT INTO PRESCRIPTION (consultation_id, patient_id, doctor_id, status) VALUES
(1, 5, 2, 'Dispensed'),
(2, 6, 3, 'Pending'),
(3, 7, 4, 'Dispensed'),
(4, 9, 4, 'Pending');

-- PRESCRIPTION_ITEM
INSERT INTO PRESCRIPTION_ITEM (prescription_id, medicine_id, dosage, duration_days, quantity) VALUES
(1, 4, '1-0-1', 10, 20),
(1, 7, '1-0-0', 10, 10),
(2, 4, '1-1-1', 5, 15),
(3, 1, '1-1-1', 5, 15),
(3, 2, '1-0-1', 7, 14),
(4, 5, '1-0-1', 30, 60);

-- LAB_TEST
INSERT INTO LAB_TEST (test_name, test_category, price) VALUES
('CBC', 'Pathology', 350.00),
('Lipid Profile', 'Pathology', 600.00),
('X-Ray Chest', 'Radiology', 450.00),
('Blood Sugar Fasting', 'Pathology', 150.00),
('Thyroid Profile', 'Pathology', 700.00),
('Urine Routine', 'Pathology', 200.00);

-- LAB_REQUEST
INSERT INTO LAB_REQUEST (consultation_id, test_id, requested_by, status) VALUES
(1, 2, 2, 'Completed'),
(2, 3, 3, 'Completed'),
(3, 1, 4, 'Completed'),
(4, 4, 4, 'Pending'),
(1, 5, 2, 'Pending');

-- LAB_REPORT  (only for the completed requests: request_id 1,2,3)
INSERT INTO LAB_REPORT (request_id, technician_id, result_summary) VALUES
(1, 12, 'LDL 145 mg/dL - borderline high, dietary advice given'),
(2, 12, 'No fracture-related soft tissue abnormality seen'),
(3, 12, 'WBC 11,200/uL - mild leukocytosis, consistent with viral infection');

-- BED
INSERT INTO BED (ward_name, bed_number, status, patient_id) VALUES
('General Ward', 'G-101', 'Occupied', 6),
('General Ward', 'G-102', 'Available', NULL),
('General Ward', 'G-103', 'Available', NULL),
('ICU', 'ICU-1', 'Occupied', 9),
('ICU', 'ICU-2', 'Available', NULL),
('Pediatric Ward', 'P-201', 'Available', NULL);

-- AMBULANCE
INSERT INTO AMBULANCE (vehicle_number, driver_name, driver_phone, status) VALUES
('MH12AB1234', 'Ganesh Pawar', '9700011111', 'Available'),
('MH12AB5678', 'Ramesh Yadav', '9700022222', 'On Duty'),
('MH12AB9012', 'Santosh Gaikwad', '9700033333', 'Available'),
('MH12AB3456', 'Dinesh Kamble', '9700044444', 'Available'),
('MH12AB7890', 'Vijay Shinde', '9700055555', 'On Duty');

-- BLOOD_BANK  (all 8 groups)
INSERT INTO BLOOD_BANK (blood_group, units_available) VALUES
('A+', 25),('A-', 8),('B+', 30),('B-', 6),('AB+', 10),('AB-', 3),('O+', 40),('O-', 12);

-- BILL
INSERT INTO BILL (patient_id, appointment_id, total_amount, payment_status, generated_by) VALUES
(5, 1, 1500.00, 'Paid', 14),
(6, 2, 700.00, 'Unpaid', 14),
(7, 3, 950.00, 'Paid', 14),
(9, 5, 500.00, 'Unpaid', 14),
(5, 7, 500.00, 'Partial', 14),
(6, 8, 900.00, 'Unpaid', 14);

-- BILL_ITEM
INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES
(1, 'Consultation', 'Cardiology consultation - Dr. Sharma', 900.00),
(1, 'Lab', 'Lipid Profile', 600.00),
(2, 'Consultation', 'Orthopedic consultation - Dr. Mehta', 700.00),
(3, 'Consultation', 'General Medicine consultation - Dr. Iyer', 500.00),
(3, 'Lab', 'CBC', 350.00),
(3, 'Medicine', 'Paracetamol + Amoxicillin', 100.00),
(4, 'Consultation', 'General Medicine consultation - Dr. Iyer', 500.00),
(5, 'Consultation', 'General Medicine consultation - Dr. Iyer', 500.00),
(6, 'Consultation', 'Cardiology consultation - Dr. Sharma', 900.00);

-- NOTIFICATION
INSERT INTO NOTIFICATION (user_id, message, is_read) VALUES
(5, 'Your appointment with Dr. Sharma is confirmed for 10 Sep, 9:30 AM', TRUE),
(6, 'Your lab report for X-Ray Chest is ready', FALSE),
(7, 'Prescription dispensed - visit pharmacy for pickup', TRUE),
(9, 'Your appointment on 12 Sep has been cancelled', TRUE),
(5, 'Reminder: appointment tomorrow at 4:00 PM', FALSE),
(6, 'Bill #2 is pending payment of ₹700', FALSE);

-- AUDIT_LOG
INSERT INTO AUDIT_LOG (user_id, action, table_affected) VALUES
(14, 'INSERT appointment for patient_id 5', 'APPOINTMENT'),
(2, 'UPDATE prescription status to Dispensed', 'PRESCRIPTION'),
(12, 'INSERT lab report for request_id 1', 'LAB_REPORT'),
(1, 'UPDATE medicine stock_qty', 'MEDICINE'),
(14, 'INSERT bill for patient_id 6', 'BILL'),
(9, 'CANCELLED own appointment', 'APPOINTMENT');
USE medivault;

-- ================= PART C: ALTER / TRUNCATE / DROP + realistic UPDATE / DELETE =================

-- ===================== ALTER TABLE demonstrations =====================

-- ADD a column
ALTER TABLE PATIENT ADD COLUMN allergies VARCHAR(200) AFTER blood_group;

-- MODIFY a column's type/width
ALTER TABLE DOCTOR MODIFY COLUMN qualification VARCHAR(120);

-- DROP a column (shift scheduling has moved to a separate roster system)
ALTER TABLE STAFF DROP COLUMN shift;

-- ===================== TRUNCATE demonstration =====================
-- AUDIT_LOG is a leaf table (nothing has a FK pointing into it), so it can be
-- truncated safely to reset the log without touching any other table.
TRUNCATE TABLE AUDIT_LOG;

INSERT INTO AUDIT_LOG (user_id, action, table_affected) VALUES
(1, 'TRUNCATE audit log for new semester', 'AUDIT_LOG');

-- ===================== DROP demonstration =====================
-- Create a throwaway scratch table, then drop it, to show DROP TABLE syntax
-- without touching real project tables.
CREATE TABLE DEMO_SCRATCH (id INT PRIMARY KEY, note VARCHAR(50));
DROP TABLE DEMO_SCRATCH;

-- ===================== Realistic UPDATE statements, per module =====================

-- Appointments: mark a scheduled visit as completed after the doctor sees the patient
UPDATE APPOINTMENT SET status = 'Completed' WHERE appointment_id = 4;

-- Pharmacy: manually decrement stock after dispensing (Phase 4 automates this with a trigger)
UPDATE MEDICINE SET stock_qty = stock_qty - 20 WHERE medicine_id = 4;
UPDATE PRESCRIPTION SET status = 'Dispensed' WHERE prescription_id = 2;

-- Billing: record a payment
UPDATE BILL SET payment_status = 'Paid' WHERE bill_id = 2;

-- Patient records: correct an emergency contact number
UPDATE PATIENT SET emergency_contact = '9900011199' WHERE patient_id = 5;

-- Beds: free up a bed on patient discharge
UPDATE BED SET status = 'Available', patient_id = NULL WHERE bed_id = 4;

-- Blood bank: log a donation
UPDATE BLOOD_BANK SET units_available = units_available + 5, last_updated = NOW() WHERE blood_group = 'O+';

-- ===================== Realistic DELETE statements, per module =====================

-- Notifications: clear read notifications older than the demo (housekeeping)
DELETE FROM NOTIFICATION WHERE is_read = TRUE;

-- Appointments: remove a cancelled appointment that was booked in error
-- (safe here because CONSULTATION/PRESCRIPTION/LAB_REQUEST never reference appointment_id 6)
DELETE FROM APPOINTMENT WHERE appointment_id = 6;

-- Ambulance fleet: decommission a vehicle that failed inspection
DELETE FROM AMBULANCE WHERE vehicle_number = 'MH12AB3456';
