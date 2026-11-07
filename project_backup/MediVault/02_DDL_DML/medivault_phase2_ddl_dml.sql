-- ============================================================================
-- MediVault / MediCare -- Canonical Normalized Database Schema (3NF)
-- MySQL 8.0 / MariaDB 10.5+ compatible
-- Replaces Phase 2 DDL, Emergency Migrations, and ALTER Table Demos
-- ============================================================================

DROP DATABASE IF EXISTS medivault;
CREATE DATABASE medivault CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE medivault;

-- ============================================================================
-- 1. IDENTITY & ACCESS CLUSTER
-- ============================================================================

-- 1.1 ROLE
CREATE TABLE ROLE (
    role_id     INT AUTO_INCREMENT PRIMARY KEY,
    role_name   VARCHAR(30) NOT NULL UNIQUE
) ENGINE=InnoDB;

-- 1.2 USER
CREATE TABLE `USER` (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(100) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    phone           VARCHAR(20),
    role_id         INT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES ROLE(role_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 1.3 DEPARTMENT (hod_doctor_id circular FK added after DOCTOR creation)
CREATE TABLE DEPARTMENT (
    department_id   INT AUTO_INCREMENT PRIMARY KEY,
    department_name VARCHAR(80) NOT NULL UNIQUE,
    floor_no        INT,
    hod_doctor_id   INT NULL
) ENGINE=InnoDB;

-- 1.4 DOCTOR (extends USER; 1:1 subtype)
CREATE TABLE DOCTOR (
    doctor_id           INT PRIMARY KEY,
    department_id       INT NOT NULL,
    specialization      VARCHAR(80),
    qualification       VARCHAR(120),
    consultation_fee    DECIMAL(8,2) NOT NULL DEFAULT 0.00 CHECK (consultation_fee >= 0),
    experience_years    INT DEFAULT 0 CHECK (experience_years >= 0),
    CONSTRAINT fk_doctor_user FOREIGN KEY (doctor_id) REFERENCES `USER`(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_doctor_dept FOREIGN KEY (department_id) REFERENCES DEPARTMENT(department_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

ALTER TABLE DEPARTMENT
    ADD CONSTRAINT fk_dept_hod FOREIGN KEY (hod_doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE SET NULL;

-- 1.5 DOCTOR_SHIFT
CREATE TABLE DOCTOR_SHIFT (
    shift_id    INT AUTO_INCREMENT PRIMARY KEY,
    doctor_id   INT NOT NULL,
    shift_date  DATE NOT NULL,
    shift_type  VARCHAR(20) NOT NULL CHECK (shift_type IN ('Morning','Evening','Night')),
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    is_on_duty  BOOLEAN NOT NULL DEFAULT TRUE,
    INDEX idx_shift_doc_date (doctor_id, shift_date),
    CONSTRAINT fk_shift_doctor FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 1.6 DOCTOR_LEAVE
CREATE TABLE DOCTOR_LEAVE (
    leave_id    INT AUTO_INCREMENT PRIMARY KEY,
    doctor_id   INT NOT NULL,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    reason      TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'Approved' CHECK (status IN ('Pending','Approved','Rejected')),
    approved_by INT NULL,
    INDEX idx_leave_doc (doctor_id, start_date, end_date),
    CONSTRAINT fk_leave_doctor   FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE CASCADE,
    CONSTRAINT fk_leave_approver FOREIGN KEY (approved_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 1.7 PATIENT (extends USER; 1NF: multi-valued allergies moved to PATIENT_ALLERGY)
CREATE TABLE PATIENT (
    patient_id          INT PRIMARY KEY,
    dob                 DATE,
    gender              CHAR(1) CHECK (gender IN ('M','F','O')),
    blood_group         VARCHAR(3) CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
    address             VARCHAR(200),
    emergency_contact   VARCHAR(100),
    CONSTRAINT fk_patient_user FOREIGN KEY (patient_id) REFERENCES `USER`(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 1.8 PATIENT_ALLERGY (1NF fix: atomic allergy rows per patient)
CREATE TABLE PATIENT_ALLERGY (
    allergy_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NOT NULL,
    allergy_name    VARCHAR(100) NOT NULL,
    severity        VARCHAR(20) NOT NULL DEFAULT 'Moderate' CHECK (severity IN ('Mild','Moderate','Severe')),
    noted_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_patient_allergy UNIQUE (patient_id, allergy_name),
    CONSTRAINT fk_allergy_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 1.9 STAFF (extends USER)
CREATE TABLE STAFF (
    staff_id        INT PRIMARY KEY,
    staff_type      ENUM('NURSE','LAB_TECHNICIAN','PHARMACIST','RECEPTIONIST') NOT NULL,
    department_id   INT NULL,
    shift           ENUM('Morning','Evening','Night') DEFAULT 'Morning',
    CONSTRAINT fk_staff_user FOREIGN KEY (staff_id) REFERENCES `USER`(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_staff_dept FOREIGN KEY (department_id) REFERENCES DEPARTMENT(department_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================================
-- 2. OUTPATIENT & CLINICAL CLUSTER
-- ============================================================================

-- 2.1 APPOINTMENT (3NF: department_id removed, derived via doctor_id -> DOCTOR.department_id)
-- Includes active_slot_date generated column so UNIQUE(doctor_id, active_slot_date, appointment_time)
-- prevents double-booking active appointments while allowing re-booking after Cancelled.
CREATE TABLE APPOINTMENT (
    appointment_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    doctor_id           INT NOT NULL,
    appointment_date    DATE NOT NULL,
    appointment_time    TIME NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'Scheduled'
                        CHECK (status IN ('Scheduled','Confirmed','Checked In','Completed','Cancelled')),
    active_slot_date    DATE GENERATED ALWAYS AS (
                            CASE WHEN status IN ('Scheduled','Confirmed','Checked In') THEN appointment_date ELSE NULL END
                        ) VIRTUAL,
    booked_by           INT NULL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_doctor_active_slot UNIQUE (doctor_id, active_slot_date, appointment_time),
    CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_appt_doctor  FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE RESTRICT,
    CONSTRAINT fk_appt_booker  FOREIGN KEY (booked_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 2.2 MEDICAL_RECORD
CREATE TABLE MEDICAL_RECORD (
    record_id           INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    doctor_id           INT NOT NULL,
    diagnosis_summary   VARCHAR(500),
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_mr_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_mr_doctor  FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 2.3 CONSULTATION
CREATE TABLE CONSULTATION (
    consultation_id     INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id      INT NOT NULL UNIQUE,
    symptoms            VARCHAR(300),
    diagnosis           VARCHAR(300),
    notes               VARCHAR(500),
    consultation_date   DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_consult_appt FOREIGN KEY (appointment_id) REFERENCES APPOINTMENT(appointment_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 3. PHARMACY & DISPENSING CLUSTER
-- ============================================================================

-- 3.1 MEDICINE (3NF: catalog attributes only; stock_qty & expiry_date moved to MEDICINE_BATCH)
CREATE TABLE MEDICINE (
    medicine_id     INT AUTO_INCREMENT PRIMARY KEY,
    medicine_name   VARCHAR(100) NOT NULL UNIQUE,
    manufacturer    VARCHAR(100),
    unit_price      DECIMAL(8,2) NOT NULL CHECK (unit_price >= 0)
) ENGINE=InnoDB;

-- 3.2 MEDICINE_BATCH (3NF: per-batch stock quantity and expiry date)
CREATE TABLE MEDICINE_BATCH (
    batch_id        INT AUTO_INCREMENT PRIMARY KEY,
    medicine_id     INT NOT NULL,
    batch_number    VARCHAR(40) NOT NULL,
    expiry_date     DATE NOT NULL,
    available_qty   INT NOT NULL DEFAULT 0 CHECK (available_qty >= 0),
    received_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_medicine_batch UNIQUE (medicine_id, batch_number),
    INDEX idx_batch_med_expiry (medicine_id, expiry_date),
    CONSTRAINT fk_batch_medicine FOREIGN KEY (medicine_id) REFERENCES MEDICINE(medicine_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3.3 PRESCRIPTION (3NF: patient_id & doctor_id removed, derived via consultation_id -> CONSULTATION -> APPOINTMENT)
CREATE TABLE PRESCRIPTION (
    prescription_id     INT AUTO_INCREMENT PRIMARY KEY,
    consultation_id     INT NOT NULL,
    prescribed_date     DATETIME DEFAULT CURRENT_TIMESTAMP,
    status              VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Dispensed')),
    CONSTRAINT fk_presc_consult FOREIGN KEY (consultation_id) REFERENCES CONSULTATION(consultation_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3.4 PRESCRIPTION_ITEM (Includes instructions column for timing/frequency)
CREATE TABLE PRESCRIPTION_ITEM (
    item_id             INT AUTO_INCREMENT PRIMARY KEY,
    prescription_id     INT NOT NULL,
    medicine_id         INT NOT NULL,
    dosage              VARCHAR(50),
    instructions        VARCHAR(200) NULL,
    duration_days       INT CHECK (duration_days > 0),
    quantity            INT NOT NULL CHECK (quantity > 0),
    CONSTRAINT fk_item_presc FOREIGN KEY (prescription_id) REFERENCES PRESCRIPTION(prescription_id) ON DELETE CASCADE,
    CONSTRAINT fk_item_med   FOREIGN KEY (medicine_id) REFERENCES MEDICINE(medicine_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 3.5 DISPENSING_RECORD (Tracks pharmacist dispensing transaction)
CREATE TABLE DISPENSING_RECORD (
    dispensing_id   INT AUTO_INCREMENT PRIMARY KEY,
    prescription_id INT NOT NULL UNIQUE,
    pharmacist_id   INT NULL,
    dispensed_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes           VARCHAR(255) NULL,
    CONSTRAINT fk_disp_presc      FOREIGN KEY (prescription_id) REFERENCES PRESCRIPTION(prescription_id) ON DELETE CASCADE,
    CONSTRAINT fk_disp_pharmacist FOREIGN KEY (pharmacist_id) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 3.6 DISPENSING_ITEM (Tracks exact batch deductions per prescription item)
CREATE TABLE DISPENSING_ITEM (
    dispensing_item_id      INT AUTO_INCREMENT PRIMARY KEY,
    dispensing_id           INT NOT NULL,
    prescription_item_id    INT NOT NULL,
    batch_id                INT NOT NULL,
    quantity_dispensed      INT NOT NULL CHECK (quantity_dispensed > 0),
    CONSTRAINT fk_dispitem_disp  FOREIGN KEY (dispensing_id) REFERENCES DISPENSING_RECORD(dispensing_id) ON DELETE CASCADE,
    CONSTRAINT fk_dispitem_pitem FOREIGN KEY (prescription_item_id) REFERENCES PRESCRIPTION_ITEM(item_id) ON DELETE CASCADE,
    CONSTRAINT fk_dispitem_batch FOREIGN KEY (batch_id) REFERENCES MEDICINE_BATCH(batch_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ============================================================================
-- 4. DIAGNOSTICS / LAB CLUSTER
-- ============================================================================

-- 4.1 LAB_TEST
CREATE TABLE LAB_TEST (
    test_id         INT AUTO_INCREMENT PRIMARY KEY,
    test_name       VARCHAR(100) NOT NULL UNIQUE,
    test_category   VARCHAR(50),
    price           DECIMAL(8,2) NOT NULL CHECK (price >= 0)
) ENGINE=InnoDB;

-- 4.2 LAB_REQUEST (Includes priority column)
CREATE TABLE LAB_REQUEST (
    request_id      INT AUTO_INCREMENT PRIMARY KEY,
    consultation_id INT NOT NULL,
    test_id         INT NOT NULL,
    requested_by    INT NOT NULL,
    priority        VARCHAR(20) NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Normal','Urgent','Emergency')),
    status          VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed')),
    request_date    DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_labreq_consult FOREIGN KEY (consultation_id) REFERENCES CONSULTATION(consultation_id) ON DELETE CASCADE,
    CONSTRAINT fk_labreq_test    FOREIGN KEY (test_id) REFERENCES LAB_TEST(test_id) ON DELETE RESTRICT,
    CONSTRAINT fk_labreq_doctor  FOREIGN KEY (requested_by) REFERENCES DOCTOR(doctor_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 4.3 LAB_REPORT
CREATE TABLE LAB_REPORT (
    report_id       INT AUTO_INCREMENT PRIMARY KEY,
    request_id      INT NOT NULL UNIQUE,
    technician_id   INT NOT NULL,
    result_summary  VARCHAR(500),
    report_date     DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_report_req   FOREIGN KEY (request_id) REFERENCES LAB_REQUEST(request_id) ON DELETE CASCADE,
    CONSTRAINT fk_report_staff FOREIGN KEY (technician_id) REFERENCES STAFF(staff_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- ============================================================================
-- 5. FACILITIES, INPATIENT & EMERGENCY CLUSTER
-- ============================================================================

-- 5.1 WARD (3NF: normalized ward entity)
CREATE TABLE WARD (
    ward_id     INT AUTO_INCREMENT PRIMARY KEY,
    ward_name   VARCHAR(50) NOT NULL UNIQUE,
    floor_no    INT DEFAULT 1,
    ward_type   VARCHAR(30) DEFAULT 'General',
    daily_rate  DECIMAL(8,2) NOT NULL DEFAULT 1000.00 CHECK (daily_rate >= 0)
) ENGINE=InnoDB;

-- 5.2 BED (3NF: references ward_id; occupancy derived from active ADMISSION / EMERGENCY_BED_ASSIGNMENT)
CREATE TABLE BED (
    bed_id      INT AUTO_INCREMENT PRIMARY KEY,
    ward_id     INT NOT NULL,
    bed_number  VARCHAR(10) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'Available'
                CHECK (status IN ('Available','Occupied','Cleaning','Reserved','Maintenance')),
    CONSTRAINT uq_ward_bed UNIQUE (ward_id, bed_number),
    CONSTRAINT fk_bed_ward FOREIGN KEY (ward_id) REFERENCES WARD(ward_id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 5.3 AMBULANCE
CREATE TABLE AMBULANCE (
    ambulance_id    INT AUTO_INCREMENT PRIMARY KEY,
    vehicle_number  VARCHAR(20) NOT NULL UNIQUE,
    driver_name     VARCHAR(100),
    driver_phone    VARCHAR(15),
    status          VARCHAR(15) NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','On Duty','Maintenance'))
) ENGINE=InnoDB;

-- 5.4 BLOOD_BANK
CREATE TABLE BLOOD_BANK (
    blood_id            INT AUTO_INCREMENT PRIMARY KEY,
    blood_group         VARCHAR(3) NOT NULL UNIQUE CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
    units_available     INT NOT NULL DEFAULT 0 CHECK (units_available >= 0),
    last_updated        DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 5.5 EMERGENCY_SEQUENCE (Concurrency-safe sequence generator for EMG-YYYY-XXX)
CREATE TABLE EMERGENCY_SEQUENCE (
    seq_year    INT PRIMARY KEY,
    last_val    INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- 5.6 EMERGENCY_CASE (3NF: doctor and bed assignments tracked in history tables)
CREATE TABLE EMERGENCY_CASE (
    case_id             INT AUTO_INCREMENT PRIMARY KEY,
    emg_number          VARCHAR(30) NOT NULL UNIQUE,
    patient_id          INT NULL,
    temp_patient_name   VARCHAR(100) NULL,
    temp_patient_gender CHAR(1) NULL CHECK (temp_patient_gender IN ('M','F','O')),
    temp_patient_age    INT NULL CHECK (temp_patient_age >= 0),
    contact_phone       VARCHAR(20) NULL,
    emergency_contact   VARCHAR(100) NULL,
    arrival_time        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    arrival_method      VARCHAR(50) NOT NULL DEFAULT 'Walk-in',
    ambulance_id        INT NULL,
    initial_complaint   TEXT NOT NULL,
    triage_priority     VARCHAR(10) NOT NULL DEFAULT 'P3' CHECK (triage_priority IN ('P1','P2','P3','P4')),
    status              VARCHAR(30) NOT NULL DEFAULT 'Waiting'
                        CHECK (status IN ('Waiting','Triage','Assigned','In Treatment','Admitted','Discharged','Transferred')),
    department_id       INT NULL,
    treatment_notes     TEXT NULL,
    discharge_summary   TEXT NULL,
    discharged_at       DATETIME NULL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_emg_status (status),
    INDEX idx_emg_priority (triage_priority),
    INDEX idx_emg_arrival (arrival_time),
    CONSTRAINT fk_emg_patient   FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE SET NULL,
    CONSTRAINT fk_emg_ambulance FOREIGN KEY (ambulance_id) REFERENCES AMBULANCE(ambulance_id) ON DELETE SET NULL,
    CONSTRAINT fk_emg_dept      FOREIGN KEY (department_id) REFERENCES DEPARTMENT(department_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.7 EMERGENCY_DOCTOR_ASSIGNMENT (Assignment history; active assignment has is_active = TRUE)
CREATE TABLE EMERGENCY_DOCTOR_ASSIGNMENT (
    assignment_id   INT AUTO_INCREMENT PRIMARY KEY,
    case_id         INT NOT NULL,
    doctor_id       INT NOT NULL,
    assigned_by     INT NULL,
    override_reason VARCHAR(255) NULL,
    assigned_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    unassigned_at   DATETIME NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    INDEX idx_eda_case_active (case_id, is_active),
    INDEX idx_eda_doc_active (doctor_id, is_active),
    CONSTRAINT fk_eda_case   FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    CONSTRAINT fk_eda_doctor FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE CASCADE,
    CONSTRAINT fk_eda_user   FOREIGN KEY (assigned_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.8 EMERGENCY_BED_ASSIGNMENT (Bed assignment history; active assignment has is_active = TRUE)
CREATE TABLE EMERGENCY_BED_ASSIGNMENT (
    assignment_id   INT AUTO_INCREMENT PRIMARY KEY,
    case_id         INT NOT NULL,
    bed_id          INT NOT NULL,
    assigned_by     INT NULL,
    assigned_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    released_at     DATETIME NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    INDEX idx_eba_case_active (case_id, is_active),
    INDEX idx_eba_bed_active (bed_id, is_active),
    CONSTRAINT fk_eba_case FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    CONSTRAINT fk_eba_bed  FOREIGN KEY (bed_id) REFERENCES BED(bed_id) ON DELETE CASCADE,
    CONSTRAINT fk_eba_user FOREIGN KEY (assigned_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.9 AMBULANCE_DISPATCH (Links ambulance dispatch to emergency case)
CREATE TABLE AMBULANCE_DISPATCH (
    dispatch_id     INT AUTO_INCREMENT PRIMARY KEY,
    ambulance_id    INT NOT NULL,
    case_id         INT NULL,
    patient_name    VARCHAR(100) NOT NULL,
    pickup_location VARCHAR(255) NOT NULL,
    destination     VARCHAR(255) NOT NULL DEFAULT 'Hospital',
    contact_phone   VARCHAR(20) NOT NULL,
    dispatched_by   INT NULL,
    dispatched_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at    DATETIME NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'In Transit' CHECK (status IN ('In Transit','Completed','Cancelled')),
    CONSTRAINT fk_disp_ambulance FOREIGN KEY (ambulance_id) REFERENCES AMBULANCE(ambulance_id) ON DELETE CASCADE,
    CONSTRAINT fk_disp_case      FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE SET NULL,
    CONSTRAINT fk_disp_user      FOREIGN KEY (dispatched_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.10 TRIAGE_ASSESSMENT
CREATE TABLE TRIAGE_ASSESSMENT (
    assessment_id       INT AUTO_INCREMENT PRIMARY KEY,
    case_id             INT NOT NULL,
    nurse_id            INT NULL,
    bp_systolic         INT,
    bp_diastolic        INT,
    heart_rate          INT,
    spo2                INT,
    temperature         DECIMAL(4,1),
    respiratory_rate    INT,
    consciousness_level VARCHAR(20) DEFAULT 'Alert',
    gcs_score           INT NULL,
    priority            VARCHAR(10) NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
    priority_reason     TEXT NULL,
    symptoms            TEXT,
    injury_details      TEXT,
    assessment_notes    TEXT,
    assessed_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_triage_case (case_id),
    CONSTRAINT fk_triage_case  FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    CONSTRAINT fk_triage_nurse FOREIGN KEY (nurse_id) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.11 EMERGENCY_PRIORITY_LOG
CREATE TABLE EMERGENCY_PRIORITY_LOG (
    log_id          INT AUTO_INCREMENT PRIMARY KEY,
    case_id         INT NOT NULL,
    old_priority    VARCHAR(10) NOT NULL,
    new_priority    VARCHAR(10) NOT NULL,
    changed_by      INT NULL,
    reason          TEXT NOT NULL,
    changed_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_epl_case FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    CONSTRAINT fk_epl_user FOREIGN KEY (changed_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.12 EMERGENCY_TREATMENT_LOG
CREATE TABLE EMERGENCY_TREATMENT_LOG (
    treatment_id    INT AUTO_INCREMENT PRIMARY KEY,
    case_id         INT NOT NULL,
    doctor_id       INT NOT NULL,
    action_type     VARCHAR(50) NOT NULL,
    description     TEXT NOT NULL,
    performed_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_etl_case   FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    CONSTRAINT fk_etl_doctor FOREIGN KEY (doctor_id) REFERENCES `USER`(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5.13 BLOOD_REQUEST
CREATE TABLE BLOOD_REQUEST (
    request_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NULL,
    case_id         INT NULL,
    requested_by    INT NOT NULL,
    blood_group     VARCHAR(3) NOT NULL CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
    units           INT NOT NULL CHECK (units > 0),
    priority        VARCHAR(20) NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Normal','Urgent','Emergency')),
    reason          TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Fulfilled')),
    approved_by     INT NULL,
    fulfilled_at    DATETIME NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_blood_req_status (status),
    CONSTRAINT fk_br_patient   FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE SET NULL,
    CONSTRAINT fk_br_case      FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE SET NULL,
    CONSTRAINT fk_br_requester FOREIGN KEY (requested_by) REFERENCES `USER`(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_br_approver  FOREIGN KEY (approved_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.14 PATIENT_VITALS
CREATE TABLE PATIENT_VITALS (
    vitals_id           INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NULL,
    case_id             INT NULL,
    recorded_by         INT NOT NULL,
    bp_systolic         INT,
    bp_diastolic        INT,
    heart_rate          INT,
    spo2                INT,
    temperature         DECIMAL(4,1),
    respiratory_rate    INT,
    notes               TEXT,
    recorded_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_vitals_patient (patient_id),
    INDEX idx_vitals_case (case_id),
    CONSTRAINT fk_vitals_patient  FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_vitals_case     FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    CONSTRAINT fk_vitals_recorder FOREIGN KEY (recorded_by) REFERENCES `USER`(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5.15 NURSE_NOTE
CREATE TABLE NURSE_NOTE (
    note_id     INT AUTO_INCREMENT PRIMARY KEY,
    patient_id  INT NULL,
    case_id     INT NULL,
    bed_id      INT NULL,
    nurse_id    INT NOT NULL,
    note_type   VARCHAR(30) DEFAULT 'General',
    content     TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_note_patient (patient_id),
    INDEX idx_note_case (case_id),
    CONSTRAINT fk_note_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_note_case    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    CONSTRAINT fk_note_bed     FOREIGN KEY (bed_id) REFERENCES BED(bed_id) ON DELETE SET NULL,
    CONSTRAINT fk_note_nurse   FOREIGN KEY (nurse_id) REFERENCES `USER`(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5.16 ADMISSION_REQUEST (Doctor-to-Nurse inpatient admission handoff)
CREATE TABLE ADMISSION_REQUEST (
    request_id          INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    doctor_id           INT NOT NULL,
    consultation_id     INT NULL,
    appointment_id      INT NULL,
    recommended_ward_id INT NOT NULL,
    priority            VARCHAR(20) NOT NULL DEFAULT 'Urgent' CHECK (priority IN ('Standard','Urgent','Critical')),
    reason              TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Assigned','Cancelled')),
    assigned_bed_id     INT NULL,
    assigned_by         INT NULL,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    assigned_at         DATETIME NULL,
    INDEX idx_admreq_status (status),
    CONSTRAINT fk_admreq_patient  FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_admreq_doctor   FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE CASCADE,
    CONSTRAINT fk_admreq_consult  FOREIGN KEY (consultation_id) REFERENCES CONSULTATION(consultation_id) ON DELETE SET NULL,
    CONSTRAINT fk_admreq_appt     FOREIGN KEY (appointment_id) REFERENCES APPOINTMENT(appointment_id) ON DELETE SET NULL,
    CONSTRAINT fk_admreq_ward     FOREIGN KEY (recommended_ward_id) REFERENCES WARD(ward_id) ON DELETE RESTRICT,
    CONSTRAINT fk_admreq_bed      FOREIGN KEY (assigned_bed_id) REFERENCES BED(bed_id) ON DELETE SET NULL,
    CONSTRAINT fk_admreq_assigner FOREIGN KEY (assigned_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.17 ADMISSION (3NF: ward_name removed; derived via bed_id -> BED.ward_id -> WARD.ward_name)
CREATE TABLE ADMISSION (
    admission_id        INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    case_id             INT NULL,
    request_id          INT NULL,
    admitting_doctor_id INT NULL,
    bed_id              INT NOT NULL,
    admitted_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    discharged_at       DATETIME NULL,
    discharge_summary   TEXT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'Admitted' CHECK (status IN ('Admitted','Discharged','Transferred')),
    INDEX idx_admission_patient (patient_id),
    INDEX idx_admission_bed_status (bed_id, status),
    INDEX idx_admission_status (status),
    CONSTRAINT fk_adm_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    CONSTRAINT fk_adm_case    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE SET NULL,
    CONSTRAINT fk_adm_req     FOREIGN KEY (request_id) REFERENCES ADMISSION_REQUEST(request_id) ON DELETE SET NULL,
    CONSTRAINT fk_adm_doctor  FOREIGN KEY (admitting_doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE SET NULL,
    CONSTRAINT fk_adm_bed     FOREIGN KEY (bed_id) REFERENCES BED(bed_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================================
-- 6. BILLING & PAYMENTS CLUSTER
-- ============================================================================

-- 6.1 BILL (3NF: total_amount and payment_status removed from base table; computed via vw_bill_summary)
CREATE TABLE BILL (
    bill_id         INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NOT NULL,
    appointment_id  INT NULL,
    admission_id    INT NULL,
    case_id         INT NULL,
    bill_date       DATETIME DEFAULT CURRENT_TIMESTAMP,
    generated_by    INT NULL,
    CONSTRAINT fk_bill_patient FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE RESTRICT,
    CONSTRAINT fk_bill_appt    FOREIGN KEY (appointment_id) REFERENCES APPOINTMENT(appointment_id) ON DELETE SET NULL,
    CONSTRAINT fk_bill_adm     FOREIGN KEY (admission_id) REFERENCES ADMISSION(admission_id) ON DELETE SET NULL,
    CONSTRAINT fk_bill_case    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE SET NULL,
    CONSTRAINT fk_bill_user    FOREIGN KEY (generated_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 6.2 BILL_ITEM (Allows Consultation, Lab, Medicine, Bed, Emergency, Admission)
CREATE TABLE BILL_ITEM (
    bill_item_id    INT AUTO_INCREMENT PRIMARY KEY,
    bill_id         INT NOT NULL,
    item_type       VARCHAR(20) NOT NULL
                    CHECK (item_type IN ('Consultation','Lab','Medicine','Bed','Emergency','Admission')),
    description     VARCHAR(200),
    amount          DECIMAL(8,2) NOT NULL CHECK (amount >= 0),
    CONSTRAINT fk_billitem_bill FOREIGN KEY (bill_id) REFERENCES BILL(bill_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6.3 PAYMENT (Records partial/full payments with unique receipt numbers)
CREATE TABLE PAYMENT (
    payment_id      INT AUTO_INCREMENT PRIMARY KEY,
    bill_id         INT NOT NULL,
    amount_paid     DECIMAL(10,2) NOT NULL CHECK (amount_paid > 0),
    payment_method  VARCHAR(30) NOT NULL DEFAULT 'Cash' CHECK (payment_method IN ('Cash','Card','UPI','Bank Transfer','Insurance')),
    reference_no    VARCHAR(80) NULL,
    receipt_number  VARCHAR(40) NOT NULL UNIQUE,
    paid_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    received_by     INT NULL,
    INDEX idx_payment_bill (bill_id),
    CONSTRAINT fk_payment_bill FOREIGN KEY (bill_id) REFERENCES BILL(bill_id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_user FOREIGN KEY (received_by) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================================
-- 7. CROSS-CUTTING CLUSTER
-- ============================================================================

-- 7.1 NOTIFICATION
CREATE TABLE NOTIFICATION (
    notification_id INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NOT NULL,
    message         VARCHAR(300) NOT NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES `USER`(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 7.2 AUDIT_LOG
CREATE TABLE AUDIT_LOG (
    log_id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NULL,
    action          VARCHAR(200) NOT NULL,
    table_affected  VARCHAR(50) NOT NULL,
    timestamp       DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES `USER`(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================================
-- 8. NORMALIZED & COMPATIBILITY VIEWS
-- ============================================================================

-- 8.1 vw_medicine_inventory: Computes stock_qty and earliest active expiry_date from MEDICINE_BATCH
CREATE OR REPLACE VIEW vw_medicine_inventory AS
SELECT
    m.medicine_id,
    m.medicine_name,
    m.manufacturer,
    m.unit_price,
    COALESCE(SUM(CASE WHEN mb.expiry_date >= CURDATE() THEN mb.available_qty ELSE 0 END), 0) AS stock_qty,
    COALESCE(
        MIN(CASE WHEN mb.available_qty > 0 AND mb.expiry_date >= CURDATE() THEN mb.expiry_date END),
        MIN(mb.expiry_date)
    ) AS expiry_date
FROM MEDICINE m
LEFT JOIN MEDICINE_BATCH mb ON m.medicine_id = mb.medicine_id
GROUP BY m.medicine_id, m.medicine_name, m.manufacturer, m.unit_price;

-- 8.2 vw_bill_summary: Computes total_amount, paid_amount, balance_due, and payment_status from BILL_ITEM & PAYMENT
CREATE OR REPLACE VIEW vw_bill_summary AS
SELECT
    b.bill_id,
    b.patient_id,
    b.appointment_id,
    b.admission_id,
    b.case_id,
    COALESCE(bi.total_amount, 0.00) AS total_amount,
    COALESCE(pm.paid_amount, 0.00) AS paid_amount,
    GREATEST(COALESCE(bi.total_amount, 0.00) - COALESCE(pm.paid_amount, 0.00), 0.00) AS balance_due,
    CASE
        WHEN COALESCE(bi.total_amount, 0.00) > 0 AND COALESCE(pm.paid_amount, 0.00) >= COALESCE(bi.total_amount, 0.00) THEN 'Paid'
        WHEN COALESCE(pm.paid_amount, 0.00) > 0 THEN 'Partial'
        ELSE 'Unpaid'
    END AS payment_status,
    b.bill_date,
    b.generated_by
FROM BILL b
LEFT JOIN (
    SELECT bill_id, SUM(amount) AS total_amount
    FROM BILL_ITEM
    GROUP BY bill_id
) bi ON b.bill_id = bi.bill_id
LEFT JOIN (
    SELECT bill_id, SUM(amount_paid) AS paid_amount
    FROM PAYMENT
    GROUP BY bill_id
) pm ON b.bill_id = pm.bill_id;

-- 8.3 vw_bed_details: Derives ward_name and occupying patient/case from WARD, ADMISSION, and EMERGENCY_BED_ASSIGNMENT
CREATE OR REPLACE VIEW vw_bed_details AS
SELECT
    b.bed_id,
    b.ward_id,
    w.ward_name,
    w.daily_rate,
    b.bed_number,
    b.status,
    COALESCE(adm.patient_id, ec.patient_id) AS patient_id,
    adm.admission_id,
    adm.admitting_doctor_id,
    eba.case_id,
    ec.emg_number
FROM BED b
JOIN WARD w ON b.ward_id = w.ward_id
LEFT JOIN ADMISSION adm
    ON adm.bed_id = b.bed_id AND adm.status = 'Admitted'
LEFT JOIN EMERGENCY_BED_ASSIGNMENT eba
    ON eba.bed_id = b.bed_id AND eba.is_active = TRUE
LEFT JOIN EMERGENCY_CASE ec
    ON eba.case_id = ec.case_id AND ec.status NOT IN ('Discharged', 'Transferred', 'Admitted');

-- 8.4 vw_prescription_details: Derives patient_id and doctor_id from CONSULTATION -> APPOINTMENT
CREATE OR REPLACE VIEW vw_prescription_details AS
SELECT
    pr.prescription_id,
    pr.consultation_id,
    a.patient_id,
    a.doctor_id,
    pr.prescribed_date,
    pr.status
FROM PRESCRIPTION pr
JOIN CONSULTATION c ON pr.consultation_id = c.consultation_id
JOIN APPOINTMENT a ON c.appointment_id = a.appointment_id;

-- 8.5 vw_patient_allergies: Comma-separated allergy summary per patient
CREATE OR REPLACE VIEW vw_patient_allergies AS
SELECT
    p.patient_id,
    GROUP_CONCAT(pa.allergy_name ORDER BY pa.allergy_name SEPARATOR ', ') AS allergies
FROM PATIENT p
LEFT JOIN PATIENT_ALLERGY pa ON p.patient_id = pa.patient_id
GROUP BY p.patient_id;

-- ============================================================================
-- 9. SYLLABUS EXPERIMENT 7 VIEWS
-- ============================================================================

-- 9.1 Doctor dashboard: today's schedule
CREATE OR REPLACE VIEW vw_doctor_today_schedule AS
SELECT
    a.appointment_id,
    doc.doctor_id,
    ud.name AS doctor_name,
    up.name AS patient_name,
    a.patient_id,
    a.appointment_time,
    a.status
FROM APPOINTMENT a
JOIN DOCTOR doc ON a.doctor_id = doc.doctor_id
JOIN `USER` ud ON doc.doctor_id = ud.user_id
JOIN PATIENT p ON a.patient_id = p.patient_id
JOIN `USER` up ON p.patient_id = up.user_id
WHERE a.appointment_date = CURDATE();

-- 9.2 Patient portal summary
CREATE OR REPLACE VIEW vw_patient_portal_summary AS
SELECT
    p.patient_id,
    u.name AS patient_name,
    (SELECT MIN(a.appointment_date) FROM APPOINTMENT a
       WHERE a.patient_id = p.patient_id AND a.status IN ('Scheduled','Confirmed') AND a.appointment_date >= CURDATE()
    ) AS next_appointment_date,
    (SELECT COUNT(*) FROM MEDICAL_RECORD mr WHERE mr.patient_id = p.patient_id) AS record_count,
    (SELECT COUNT(*) FROM vw_bill_summary b WHERE b.patient_id = p.patient_id AND b.payment_status <> 'Paid') AS pending_bills,
    (SELECT COUNT(*) FROM NOTIFICATION n WHERE n.user_id = p.patient_id AND n.is_read = FALSE) AS unread_notifications
FROM PATIENT p
JOIN `USER` u ON p.patient_id = u.user_id;

-- 9.3 Pharmacist dashboard: medicines that need reordering (stock_qty < 20)
CREATE OR REPLACE VIEW vw_pharmacy_low_stock AS
SELECT
    medicine_id,
    medicine_name,
    stock_qty,
    unit_price,
    expiry_date
FROM vw_medicine_inventory
WHERE stock_qty < 20;

-- 9.4 Admin dashboard: monthly revenue trend
CREATE OR REPLACE VIEW vw_monthly_revenue AS
SELECT
    DATE_FORMAT(bill_date, '%Y-%m') AS month,
    SUM(total_amount) AS revenue,
    COUNT(*) AS bill_count
FROM vw_bill_summary
GROUP BY DATE_FORMAT(bill_date, '%Y-%m');

-- 9.5 Admin / Nurse dashboard: bed occupancy by ward
CREATE OR REPLACE VIEW vw_bed_occupancy AS
SELECT
    w.ward_name,
    SUM(b.status = 'Occupied') AS occupied,
    COUNT(b.bed_id) AS total_beds,
    ROUND(100 * SUM(b.status = 'Occupied') / COUNT(b.bed_id), 1) AS occupancy_pct
FROM WARD w
JOIN BED b ON w.ward_id = b.ward_id
GROUP BY w.ward_id, w.ward_name;

-- 9.6 Receptionist dashboard snapshot
CREATE OR REPLACE VIEW vw_reception_dashboard AS
SELECT
    (SELECT COUNT(*) FROM APPOINTMENT WHERE appointment_date = CURDATE()) AS todays_appointments,
    (SELECT COUNT(*) FROM BED WHERE status = 'Available') AS available_beds,
    (SELECT COUNT(*) FROM vw_bill_summary WHERE payment_status <> 'Paid') AS pending_bills,
    (SELECT COUNT(*) FROM PATIENT) AS total_registered_patients;

-- ============================================================================
-- 10. TRIGGERS (EXPERIMENT 8)
-- ============================================================================

DELIMITER $$

-- 10.1 Decrement batch stock (FEFO) when a prescription is marked Dispensed (if not already deducted)
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
        -- Check if application transaction already recorded batch dispensing items
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

-- 10.2 Alert Admin + Pharmacists when total non-expired stock for a medicine crosses below 20
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
        FROM `USER` u
        JOIN ROLE r ON u.role_id = r.role_id
        WHERE r.role_name IN ('Admin', 'Pharmacist');
    END IF;
END$$

-- 10.3 Notify patient when an appointment is booked
CREATE TRIGGER trg_appointment_notification
AFTER INSERT ON APPOINTMENT
FOR EACH ROW
BEGIN
    INSERT INTO NOTIFICATION (user_id, message)
    VALUES (NEW.patient_id,
            CONCAT('Your appointment is booked for ', NEW.appointment_date, ' at ', NEW.appointment_time));
END$$

-- 10.4 Refuse to delete a patient who still has unpaid or partial bills
CREATE TRIGGER trg_block_patient_delete
BEFORE DELETE ON PATIENT
FOR EACH ROW
BEGIN
    DECLARE unpaid_count INT DEFAULT 0;
    SELECT COUNT(*) INTO unpaid_count
    FROM vw_bill_summary
    WHERE patient_id = OLD.patient_id AND payment_status <> 'Paid';

    IF unpaid_count > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot delete patient: unpaid or partial bills exist';
    END IF;
END$$

-- ============================================================================
-- 11. STORED PROCEDURES (TRANSACTIONAL WORKFLOWS)
-- ============================================================================

-- 11.1 sp_book_appointment: Locks doctor and checks slot availability before booking
CREATE PROCEDURE sp_book_appointment(
    IN p_patient_id INT,
    IN p_doctor_id INT,
    IN p_department_id INT,
    IN p_date DATE,
    IN p_time TIME,
    IN p_booked_by INT
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

    -- Lock the doctor row to serialize concurrent bookings for the same doctor
    SELECT department_id INTO v_doc_dept
    FROM DOCTOR
    WHERE doctor_id = p_doctor_id
    FOR UPDATE;

    IF v_doc_dept IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Selected doctor does not exist';
    END IF;

    SELECT COUNT(*) INTO slot_taken
    FROM APPOINTMENT
    WHERE doctor_id = p_doctor_id
      AND appointment_date = p_date
      AND appointment_time = p_time
      AND status IN ('Scheduled', 'Confirmed', 'Checked In')
    FOR UPDATE;

    IF slot_taken > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Selected slot is already booked for this doctor';
    END IF;

    INSERT INTO APPOINTMENT (patient_id, doctor_id, appointment_date, appointment_time, status, booked_by)
    VALUES (p_patient_id, p_doctor_id, p_date, p_time, 'Scheduled', p_booked_by);

    COMMIT;
END$$

-- 11.2 sp_generate_bill: Creates BILL and itemized BILL_ITEM rows for a completed appointment
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
    FROM APPOINTMENT
    WHERE appointment_id = p_appointment_id
    FOR UPDATE;

    SELECT consultation_id INTO v_consultation_id
    FROM CONSULTATION
    WHERE appointment_id = p_appointment_id;

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
    FROM LAB_REQUEST lr
    JOIN LAB_TEST lt ON lr.test_id = lt.test_id
    WHERE lr.consultation_id = v_consultation_id;

    INSERT INTO BILL_ITEM (bill_id, item_type, description, amount)
    SELECT v_bill_id, 'Medicine', m.medicine_name, m.unit_price * pi.quantity
    FROM PRESCRIPTION pr
    JOIN PRESCRIPTION_ITEM pi ON pr.prescription_id = pi.prescription_id
    JOIN MEDICINE m ON pi.medicine_id = m.medicine_id
    WHERE pr.consultation_id = v_consultation_id;

    COMMIT;
END$$

DELIMITER ;
-- ============================================================================
-- MediVault / MediCare -- Canonical Seed Data (DML)
-- Compatible with db/schema.sql (Normalized 3NF Schema)
-- All user accounts use real bcrypt ($2a$10$) hashes:
--   admin@medivault.in       -> admin1
--   sharma.doc@medivault.in  -> doc1
--   mehta.doc@medivault.in   -> doc2
--   iyer.doc@medivault.in    -> doc3
--   bhosale.doc@medivault.in -> doc4
--   rahul.verma@gmail.com    -> pat1
--   priya.nair@gmail.com     -> pat2
--   amit.deshmukh@gmail.com  -> pat3
--   sneha.reddy@gmail.com    -> pat4
--   vikram.chauhan@gmail.com -> pat5
--   anjali.bhatt@gmail.com   -> pat6
--   kavita.joshi@medivault.in-> staff1
--   arjun.pillai@medivault.in-> staff2
--   neha.kapoor@medivault.in -> staff3
--   suresh.rao@medivault.in  -> staff4
-- ============================================================================

USE medivault;

-- 1. ROLE
INSERT INTO ROLE (role_id, role_name) VALUES
(1, 'Admin'),
(2, 'Doctor'),
(3, 'Patient'),
(4, 'Nurse'),
(5, 'Lab Technician'),
(6, 'Pharmacist'),
(7, 'Receptionist');

-- 2. USER (15 rows: 1 Admin, 4 Doctors, 6 Patients, 4 Staff)
INSERT INTO `USER` (user_id, name, email, password_hash, phone, role_id, is_active) VALUES
(1,  'Rohan Kulkarni',    'admin@medivault.in',       '$2a$10$EBzRnAW1BgOPI4R6qDs2G.aMZIVFQSr4BR7d8g85WNGjxJkNXSb9e', '9800000001', 1, TRUE),
(2,  'Dr. Aditi Sharma',  'sharma.doc@medivault.in',  '$2a$10$Ww5.ZNUHm0iB0r.cgItHZeuieGM/HhqF48M5BqldwI3VTkPKDrJ5C', '9800000002', 2, TRUE),
(3,  'Dr. Karan Mehta',   'mehta.doc@medivault.in',   '$2a$10$y4.0qMt5WOqJfO2dY2vAJeW0RUc/lLLAqF0KmKNJfurXpncIsxGYW', '9800000003', 2, TRUE),
(4,  'Dr. Lakshmi Iyer',  'iyer.doc@medivault.in',    '$2a$10$m00NJ.W7An1r0dZmaeViBukFNeZvKjj6atv7EgomZOgu8NuLo60oK', '9800000004', 2, TRUE),
(5,  'Rahul Verma',       'rahul.verma@gmail.com',    '$2a$10$v1L1KWnJoT52YPFjadbqQOYeEifxGzBaQwu45Y97whb1IOS7r57cW', '9811100001', 3, TRUE),
(6,  'Priya Nair',        'priya.nair@gmail.com',     '$2a$10$MW7wHxkqsaoQMBjwpUeL3.V4/p0pmDzLg8/3Ev9BguA.fbicOsgl.', '9811100002', 3, TRUE),
(7,  'Amit Deshmukh',     'amit.deshmukh@gmail.com',  '$2a$10$zE/NmIUhNmzqwWkV.MsHZeW22Wc6k8x.7IczFJ.71LhmPydk3DKnu', '9811100003', 3, TRUE),
(8,  'Sneha Reddy',       'sneha.reddy@gmail.com',    '$2a$10$3Rdz4l3wkIgRbWz5E2mF.OHy.FpvT8/p48zaaSjsFxLoudxTbNRZa', '9811100004', 3, TRUE),
(9,  'Vikram Chauhan',    'vikram.chauhan@gmail.com', '$2a$10$sV5NfIs95.Iuf6pWjs4H9.i2u.H.X9SgQnnkejwaEQAjuS0SltCs2', '9811100005', 3, TRUE),
(10, 'Anjali Bhatt',      'anjali.bhatt@gmail.com',   '$2a$10$shUMjd6PHWkxX2/aQW0PmuQxk2NWvDRc01101KAQ23utRolIihFv.', '9811100006', 3, TRUE),
(11, 'Kavita Joshi',      'kavita.joshi@medivault.in','$2a$10$zlEk1ZNKJXIRiLY7N.BrMevxBzQZ3RziiurzXuwjH/gDPFZt6fybC', '9822200001', 4, TRUE),
(12, 'Arjun Pillai',      'arjun.pillai@medivault.in','$2a$10$E4BPgkGcTtEDQbAaU7ALR.aZQlBR0i9irEAGx3j/j8EWBK7tU02Cy', '9822200002', 5, TRUE),
(13, 'Neha Kapoor',       'neha.kapoor@medivault.in', '$2a$10$x2LhJTRekp0y0MjoRyQH3O6uFCJVEUWGqlXFHhVGar7PzHMkkI0h.', '9822200003', 6, TRUE),
(14, 'Suresh Rao',        'suresh.rao@medivault.in',  '$2a$10$Hz92aPYKSjih4cuZULwEBOwzdVJP6k1JNOkNFmqFtd7I/N/dmbgO6', '9822200004', 7, TRUE),
(15, 'Dr. Neha Bhosale',  'bhosale.doc@medivault.in', '$2a$10$JHiMC1Aknyu.NRaj5kbPYOsEUKk6Jjv6rRE4XyYvfHuGrEvUgbY/a', '9800000005', 2, TRUE);

-- 3. DEPARTMENT
INSERT INTO DEPARTMENT (department_id, department_name, floor_no) VALUES
(1, 'Cardiology', 2),
(2, 'Orthopedics', 3),
(3, 'General Medicine', 1),
(4, 'Pediatrics', 1),
(5, 'ENT', 2),
(6, 'Emergency Medicine', 1);

-- 4. DOCTOR
INSERT INTO DOCTOR (doctor_id, department_id, specialization, qualification, consultation_fee, experience_years) VALUES
(2,  1, 'Cardiologist',                'MD Cardiology', 900.00,  12),
(3,  2, 'Orthopedic Surgeon',          'MS Ortho',      700.00,  8),
(4,  3, 'General Physician',           'MBBS, MD',      500.00,  6),
(15, 1, 'Interventional Cardiologist', 'DM Cardiology', 1100.00, 9);

UPDATE DEPARTMENT SET hod_doctor_id = 2 WHERE department_name = 'Cardiology';
UPDATE DEPARTMENT SET hod_doctor_id = 3 WHERE department_name = 'Orthopedics';
UPDATE DEPARTMENT SET hod_doctor_id = 4 WHERE department_name = 'General Medicine';

-- 5. DOCTOR_SHIFT (Active shifts covering 00:00:00 to 23:59:59 for today and next 7 days so doctors are on duty)
INSERT INTO DOCTOR_SHIFT (doctor_id, shift_date, shift_type, start_time, end_time, is_on_duty) VALUES
(2,  CURDATE(), 'Morning', '00:00:00', '23:59:59', TRUE),
(3,  CURDATE(), 'Morning', '00:00:00', '23:59:59', TRUE),
(4,  CURDATE(), 'Evening', '00:00:00', '23:59:59', TRUE),
(15, CURDATE(), 'Night',   '00:00:00', '23:59:59', TRUE),
(2,  DATE_ADD(CURDATE(), INTERVAL 1 DAY), 'Morning', '08:00:00', '16:00:00', TRUE),
(3,  DATE_ADD(CURDATE(), INTERVAL 1 DAY), 'Morning', '08:00:00', '16:00:00', TRUE),
(4,  DATE_ADD(CURDATE(), INTERVAL 1 DAY), 'Evening', '14:00:00', '22:00:00', TRUE),
(15, DATE_ADD(CURDATE(), INTERVAL 1 DAY), 'Night',   '20:00:00', '08:00:00', TRUE);

-- 6. PATIENT
INSERT INTO PATIENT (patient_id, dob, gender, blood_group, address, emergency_contact) VALUES
(5,  '1990-04-12', 'M', 'B+',  'Kothrud, Pune',           '9900011199'),
(6,  '1995-08-23', 'F', 'O+',  'Andheri, Mumbai',         '9900022222'),
(7,  '1988-01-30', 'M', 'A+',  'Koramangala, Bengaluru',  '9900033333'),
(8,  '2001-11-05', 'F', 'AB-', 'Banjara Hills, Hyderabad','9900044444'),
(9,  '1979-06-18', 'M', 'O-',  'Salt Lake, Kolkata',      '9900055555'),
(10, '1998-03-27', 'F', 'B-',  'Vastrapur, Ahmedabad',    '9900066666');

-- 7. PATIENT_ALLERGY (1NF normalized allergies)
INSERT INTO PATIENT_ALLERGY (patient_id, allergy_name, severity) VALUES
(5, 'Penicillin',   'Severe'),
(5, 'Dust Mites',   'Mild'),
(6, 'Sulfa Drugs',  'Moderate'),
(8, 'Peanuts',      'Severe'),
(9, 'Aspirin',      'Moderate');

-- 8. STAFF
INSERT INTO STAFF (staff_id, staff_type, department_id, shift) VALUES
(11, 'NURSE',          1,    'Morning'),
(12, 'LAB_TECHNICIAN', 3,    'Morning'),
(13, 'PHARMACIST',     NULL, 'Evening'),
(14, 'RECEPTIONIST',   NULL, 'Morning');

-- 9. APPOINTMENT (3NF: department_id omitted; derived from doctor_id)
INSERT INTO APPOINTMENT (appointment_id, patient_id, doctor_id, appointment_date, appointment_time, status, booked_by) VALUES
(1, 5, 2, '2026-09-10', '09:30:00', 'Completed', 14),
(2, 6, 3, '2026-09-10', '10:00:00', 'Completed', 14),
(3, 7, 4, '2026-09-11', '11:15:00', 'Completed', 7),
(4, 8, 2, '2026-09-12', '09:00:00', 'Scheduled', 14),
(5, 9, 4, '2026-09-12', '12:00:00', 'Completed', 9),
(6, 10, 3,'2026-09-13', '15:30:00', 'Cancelled', 14),
(7, 5, 4, '2026-09-15', '16:00:00', 'Scheduled', 5),
(8, 6, 2, '2026-09-16', '09:45:00', 'Scheduled', 14),
(9, 6, 4, '2026-09-14', '10:30:00', 'Completed', 14);

-- 10. MEDICAL_RECORD
INSERT INTO MEDICAL_RECORD (record_id, patient_id, doctor_id, diagnosis_summary) VALUES
(1, 5,  2, 'Mild hypertension, advised lifestyle changes'),
(2, 6,  3, 'Fractured wrist, cast applied'),
(3, 7,  4, 'Seasonal viral fever'),
(4, 8,  2, 'Routine cardiac checkup, normal ECG'),
(5, 9,  4, 'Type 2 diabetes follow-up'),
(6, 10, 3, 'Lower back pain, physiotherapy advised');

-- 11. CONSULTATION
INSERT INTO CONSULTATION (consultation_id, appointment_id, symptoms, diagnosis, notes, consultation_date) VALUES
(1, 1, 'Chest tightness, fatigue',   'Mild hypertension',       'Start on low-dose medication, review in 2 weeks', '2026-09-10 09:45:00'),
(2, 2, 'Wrist pain after fall',      'Distal radius fracture',  'Cast for 4 weeks, follow-up X-ray',               '2026-09-10 10:15:00'),
(3, 3, 'Fever, body ache',           'Seasonal viral fever',    'Rest, fluids, antipyretics',                      '2026-09-11 11:30:00'),
(4, 5, 'Occasional dizziness',       'Uncontrolled sugar levels','Adjust metformin dosage',                        '2026-09-12 12:15:00');

-- 12. MEDICINE (Catalog only)
INSERT INTO MEDICINE (medicine_id, medicine_name, manufacturer, unit_price) VALUES
(1, 'Paracetamol 500mg', 'Cipla',      2.50),
(2, 'Amoxicillin 250mg', 'Sun Pharma', 6.00),
(3, 'Cetirizine 10mg',   'Dr. Reddys', 1.80),
(4, 'Ibuprofen 400mg',   'Cipla',      3.20),
(5, 'Metformin 500mg',   'Sun Pharma', 2.10),
(6, 'Azithromycin 500mg','Alkem',      12.00),
(7, 'Pantoprazole 40mg', 'Dr. Reddys', 4.50),
(8, 'Vitamin D3 60K IU', 'Mankind',    8.00);

-- 13. MEDICINE_BATCH (Stock quantities and expiry dates per batch)
INSERT INTO MEDICINE_BATCH (batch_id, medicine_id, batch_number, expiry_date, available_qty) VALUES
(1, 1, 'BATCH-PARA-2027A', '2027-06-30', 500),
(2, 2, 'BATCH-AMOX-2027A', '2027-01-31', 300),
(3, 3, 'BATCH-CETI-2027A', '2027-09-30', 400),
(4, 4, 'BATCH-IBUP-2026A', '2026-12-31', 250),
(5, 5, 'BATCH-METF-2027A', '2027-03-31', 15),
(6, 6, 'BATCH-AZIT-2026A', '2026-11-30', 120),
(7, 7, 'BATCH-PANT-2027A', '2027-05-31', 200),
(8, 8, 'BATCH-VITD-2027A', '2027-08-31', 350),
(9, 5, 'BATCH-METF-EXP2025', '2025-01-31', 100);

-- 14. PRESCRIPTION (3NF: references consultation_id only)
INSERT INTO PRESCRIPTION (prescription_id, consultation_id, prescribed_date, status) VALUES
(1, 1, '2026-09-10 09:50:00', 'Dispensed'),
(2, 2, '2026-09-10 10:20:00', 'Pending'),
(3, 3, '2026-09-11 11:35:00', 'Dispensed'),
(4, 4, '2026-09-12 12:20:00', 'Pending');

-- 15. PRESCRIPTION_ITEM (Includes instructions)
INSERT INTO PRESCRIPTION_ITEM (item_id, prescription_id, medicine_id, dosage, instructions, duration_days, quantity) VALUES
(1, 1, 4, '1-0-1', 'Morning 1, Evening 1 (Twice daily after food)', 10, 20),
(2, 1, 7, '1-0-0', 'Before Food (Empty stomach morning)',           10, 10),
(3, 2, 4, '1-1-1', 'Morning 1, Afternoon 1, Evening 1 (Thrice daily)', 5, 15),
(4, 3, 1, '1-1-1', 'Morning 1, Afternoon 1, Evening 1 (Thrice daily)', 5, 15),
(5, 3, 2, '1-0-1', 'Morning 1, Evening 1 (Twice daily after food)', 7, 14),
(6, 4, 5, '1-0-1', 'Morning 1, Evening 1 (Twice daily after food)', 30, 60);

-- 16. DISPENSING_RECORD & DISPENSING_ITEM for already-dispensed prescriptions (1 and 3)
INSERT INTO DISPENSING_RECORD (dispensing_id, prescription_id, pharmacist_id, dispensed_at, notes) VALUES
(1, 1, 13, '2026-09-10 10:05:00', 'Initial seed dispensing for prescription #1'),
(2, 3, 13, '2026-09-11 11:50:00', 'Initial seed dispensing for prescription #3');

INSERT INTO DISPENSING_ITEM (dispensing_id, prescription_item_id, batch_id, quantity_dispensed) VALUES
(1, 1, 4, 20),
(1, 2, 7, 10),
(2, 4, 1, 15),
(2, 5, 2, 14);

-- 17. LAB_TEST
INSERT INTO LAB_TEST (test_id, test_name, test_category, price) VALUES
(1, 'CBC',                 'Pathology', 350.00),
(2, 'Lipid Profile',       'Pathology', 600.00),
(3, 'X-Ray Chest',         'Radiology', 450.00),
(4, 'Blood Sugar Fasting', 'Pathology', 150.00),
(5, 'Thyroid Profile',     'Pathology', 700.00),
(6, 'Urine Routine',       'Pathology', 200.00);

-- 18. LAB_REQUEST
INSERT INTO LAB_REQUEST (request_id, consultation_id, test_id, requested_by, priority, status, request_date) VALUES
(1, 1, 2, 2, 'Normal', 'Completed', '2026-09-10 09:50:00'),
(2, 2, 3, 3, 'Urgent', 'Completed', '2026-09-10 10:20:00'),
(3, 3, 1, 4, 'Normal', 'Completed', '2026-09-11 11:35:00'),
(4, 4, 4, 4, 'Normal', 'Pending',   '2026-09-12 12:20:00'),
(5, 1, 5, 2, 'Normal', 'Pending',   '2026-09-10 09:55:00');

-- 19. LAB_REPORT
INSERT INTO LAB_REPORT (report_id, request_id, technician_id, result_summary, report_date) VALUES
(1, 1, 12, 'LDL 145 mg/dL - borderline high, dietary advice given',                '2026-09-10 16:00:00'),
(2, 2, 12, 'No fracture-related soft tissue abnormality seen',                     '2026-09-10 17:00:00'),
(3, 3, 12, 'WBC 11,200/uL - mild leukocytosis, consistent with viral infection',   '2026-09-11 12:00:00');

-- 20. WARD
INSERT INTO WARD (ward_id, ward_name, floor_no, ward_type, daily_rate) VALUES
(1, 'General Ward',   1, 'General',   800.00),
(2, 'ICU',            2, 'ICU',      2500.00),
(3, 'Pediatric Ward', 1, 'Pediatric',1000.00),
(4, 'Emergency Ward', 1, 'Emergency',1200.00);

-- 21. BED (12 beds across 4 wards)
INSERT INTO BED (bed_id, ward_id, bed_number, status) VALUES
(1,  1, 'G-101', 'Occupied'),
(2,  1, 'G-102', 'Occupied'),
(3,  1, 'G-103', 'Available'),
(4,  2, 'ICU-1', 'Occupied'),
(5,  2, 'ICU-2', 'Available'),
(6,  3, 'P-201', 'Available'),
(7,  4, 'E-01',  'Occupied'),
(8,  4, 'E-02',  'Occupied'),
(9,  4, 'E-03',  'Available'),
(10, 4, 'E-04',  'Available'),
(11, 4, 'E-05',  'Available'),
(12, 4, 'E-06',  'Available');

-- 22. ADMISSION (Active inpatient admissions corresponding to occupied inpatient beds 1, 2, 4)
INSERT INTO ADMISSION (admission_id, patient_id, admitting_doctor_id, bed_id, admitted_at, status) VALUES
(1, 6, 3, 1, '2026-09-10 11:00:00', 'Admitted'),
(2, 8, 2, 2, '2026-09-12 10:00:00', 'Admitted'),
(3, 9, 4, 4, '2026-09-12 13:00:00', 'Admitted');

-- 23. AMBULANCE
INSERT INTO AMBULANCE (ambulance_id, vehicle_number, driver_name, driver_phone, status) VALUES
(1, 'MH12AB1234', 'Ganesh Pawar',    '9700011111', 'Available'),
(2, 'MH12AB5678', 'Ramesh Yadav',    '9700022222', 'On Duty'),
(3, 'MH12AB9012', 'Santosh Gaikwad', '9700033333', 'Available'),
(4, 'MH12AB3456', 'Dinesh Kamble',   '9700044444', 'Available'),
(5, 'MH12AB7890', 'Vijay Shinde',    '9700055555', 'On Duty');

-- 24. BLOOD_BANK (All 8 blood groups)
INSERT INTO BLOOD_BANK (blood_id, blood_group, units_available) VALUES
(1, 'A+',  25),
(2, 'A-',  8),
(3, 'B+',  30),
(4, 'B-',  6),
(5, 'AB+', 10),
(6, 'AB-', 3),
(7, 'O+',  40),
(8, 'O-',  12);

-- 25. EMERGENCY_SEQUENCE & EMERGENCY_CASE
INSERT INTO EMERGENCY_SEQUENCE (seq_year, last_val) VALUES (2026, 5);

INSERT INTO EMERGENCY_CASE
(case_id, emg_number, patient_id, temp_patient_name, temp_patient_gender, temp_patient_age, arrival_time, arrival_method, ambulance_id, initial_complaint, triage_priority, status, department_id)
VALUES
(1, 'EMG-2026-001', 5,    NULL,           NULL, NULL, DATE_SUB(NOW(), INTERVAL 45 MINUTE), 'Ambulance', 2,    'Acute chest pain radiating to left arm, shortness of breath, diaphoresis', 'P1', 'In Treatment', 1),
(2, 'EMG-2026-002', 7,    NULL,           NULL, NULL, DATE_SUB(NOW(), INTERVAL 30 MINUTE), 'Walk-in',   NULL, 'Suspected tibial fracture from motorbike fall, severe swelling',           'P2', 'Assigned',     2),
(3, 'EMG-2026-003', NULL, 'Unknown Male', 'M',  35,   DATE_SUB(NOW(), INTERVAL 20 MINUTE), 'Ambulance', 3,    'Unconscious on arrival, suspected head trauma, shallow breathing',         'P1', 'Waiting',      6),
(4, 'EMG-2026-004', 9,    NULL,           NULL, NULL, DATE_SUB(NOW(), INTERVAL 15 MINUTE), 'Walk-in',   NULL, 'Persistent high grade fever (103°F) and dehydration',                      'P3', 'Waiting',      3),
(5, 'EMG-2026-005', 10,   NULL,           NULL, NULL, DATE_SUB(NOW(), INTERVAL 5 MINUTE),  'Walk-in',   NULL, 'Superficial laceration on forearm from broken glass, active bleeding stopped', 'P4', 'Waiting', 6);

-- 26. EMERGENCY_DOCTOR_ASSIGNMENT & EMERGENCY_BED_ASSIGNMENT (3NF history tables)
INSERT INTO EMERGENCY_DOCTOR_ASSIGNMENT (case_id, doctor_id, assigned_by, is_active) VALUES
(1, 2, 1, TRUE),
(2, 3, 1, TRUE);

INSERT INTO EMERGENCY_BED_ASSIGNMENT (case_id, bed_id, assigned_by, is_active) VALUES
(1, 7, 1, TRUE),
(2, 8, 1, TRUE);

-- 27. AMBULANCE_DISPATCH
INSERT INTO AMBULANCE_DISPATCH (ambulance_id, case_id, patient_name, pickup_location, destination, contact_phone, dispatched_by, status) VALUES
(2, 1, 'Rahul Verma',  'Kothrud, Pune',      'MediCare Emergency Ward', '9811100001', 14, 'Completed'),
(3, 3, 'Unknown Male', 'Highway NH-48 Exit', 'MediCare Emergency Ward', '9999999999', 14, 'Completed');

-- 28. TRIAGE_ASSESSMENT
INSERT INTO TRIAGE_ASSESSMENT
(case_id, nurse_id, bp_systolic, bp_diastolic, heart_rate, spo2, temperature, respiratory_rate, consciousness_level, gcs_score, priority, priority_reason, symptoms, injury_details, assessment_notes)
VALUES
(1, 11, 165, 105, 118, 91, 98.6,  26, 'Alert', 15, 'P1', 'Severe cardiac symptom presentation with desaturation', 'Crushing substernal chest pain, radiating to left shoulder and jaw, profuse sweating', 'No visible physical trauma', 'ECG ordered immediately. Stat cardiology evaluation requested. Oxygen initiated via nasal cannula.'),
(2, 11, 130, 85,  95,  98, 99.1,  18, 'Alert', 15, 'P2', 'Open deformity, severe pain score 8/10, neurovascular check intact', 'Inability to bear weight, visible deformity of right lower leg', 'Contusions and abrasion on right shin, palpable distal pulses intact', 'Splint applied, IV analgesia administered, X-ray ordered.'),
(3, 11, 90,  55,  130, 88, 97.4,  30, 'Pain',  8,  'P1', 'GCS 8, severe respiratory distress, hemodynamic instability', 'Unresponsive to verbal stimuli, reacts sluggishly to pain', 'Hematoma left temporal region, contusions on chest', 'Bag-valve-mask ventilatory support underway. Trauma team and airway activation stat.'),
(4, 11, 115, 75,  102, 97, 103.2, 20, 'Alert', 15, 'P3', 'High fever, tachycardia secondary to pyrexia, stable vitals', 'High fever x 3 days, chills, generalized weakness', 'No trauma', 'Paracetamol IV initiated, blood cultures and CBC drawn.'),
(5, 11, 120, 80,  78,  99, 98.4,  16, 'Alert', 15, 'P4', 'Minor soft tissue laceration, hemodynamically completely stable', 'Localized pain at left forearm laceration', '3 cm superficial clean cut left forearm, bleeding controlled', 'Wound irrigation and primary suture scheduled.');

-- 29. EMERGENCY_TREATMENT_LOG
INSERT INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description) VALUES
(1, 2, 'Medication Administered', 'Aspirin 325mg chewable + Clopidogrel 300mg loading dose + Sublingual Nitroglycerin given.'),
(1, 2, 'Procedure',               '12-lead ECG obtained showing ST-elevation in leads II, III, aVF. Activated Cath Lab.'),
(2, 3, 'Observation',             'Immobilized with posterior slab. Neurovascular status reassessed: pulse 2+, capillary refill < 2s.');

-- 30. BLOOD_REQUEST
INSERT INTO BLOOD_REQUEST (request_id, patient_id, case_id, requested_by, blood_group, units, priority, reason, status) VALUES
(1, NULL, 3, 2, 'O-', 2, 'Emergency', 'Severe trauma with hemodynamic shock, emergent transfusion required', 'Pending');

-- 31. BILL, BILL_ITEM & PAYMENT (3NF: totals & status computed via vw_bill_summary)
INSERT INTO BILL (bill_id, patient_id, appointment_id, bill_date, generated_by) VALUES
(1, 5, 1, '2026-09-10 10:30:00', 14),
(2, 6, 2, '2026-09-10 11:00:00', 14),
(3, 7, 3, '2026-09-11 12:00:00', 14),
(4, 9, 5, '2026-09-12 13:00:00', 14),
(5, 5, 7, '2026-09-15 16:30:00', 14),
(6, 6, 8, '2026-09-16 10:15:00', 14);

INSERT INTO BILL_ITEM (bill_id, item_type, description, amount) VALUES
(1, 'Consultation', 'Cardiology consultation - Dr. Sharma',       900.00),
(1, 'Lab',          'Lipid Profile',                              600.00),
(2, 'Consultation', 'Orthopedic consultation - Dr. Mehta',        700.00),
(3, 'Consultation', 'General Medicine consultation - Dr. Iyer',   500.00),
(3, 'Lab',          'CBC',                                        350.00),
(3, 'Medicine',     'Paracetamol + Amoxicillin',                  100.00),
(4, 'Consultation', 'General Medicine consultation - Dr. Iyer',   500.00),
(5, 'Consultation', 'General Medicine consultation - Dr. Iyer',   500.00),
(6, 'Consultation', 'Cardiology consultation - Dr. Sharma',       900.00);

-- Payments matching seed payment statuses:
-- Bill 1: total 1500.00 -> Paid (1500.00)
-- Bill 2: total 700.00  -> Unpaid (0.00)
-- Bill 3: total 950.00  -> Paid (950.00)
-- Bill 4: total 500.00  -> Unpaid (0.00)
-- Bill 5: total 500.00  -> Partial (200.00)
-- Bill 6: total 900.00  -> Unpaid (0.00)
INSERT INTO PAYMENT (payment_id, bill_id, amount_paid, payment_method, reference_no, receipt_number, paid_at, received_by) VALUES
(1, 1, 1500.00, 'UPI',  'UPI-901234', 'RCP-2026-000001', '2026-09-10 10:35:00', 14),
(2, 3, 950.00,  'Card', 'POS-442110', 'RCP-2026-000002', '2026-09-11 12:10:00', 14),
(3, 5, 200.00,  'Cash', 'CASH-001',   'RCP-2026-000003', '2026-09-15 16:35:00', 14);

-- 32. NOTIFICATION
INSERT INTO NOTIFICATION (user_id, message, is_read) VALUES
(5, 'Your appointment with Dr. Sharma is confirmed for 10 Sep, 9:30 AM', TRUE),
(6, 'Your lab report for X-Ray Chest is ready', FALSE),
(7, 'Prescription dispensed - visit pharmacy for pickup', TRUE),
(9, 'Your appointment on 12 Sep has been cancelled', TRUE),
(5, 'Reminder: appointment tomorrow at 4:00 PM', FALSE),
(6, 'Bill #2 is pending payment of ₹700', FALSE);

-- 33. AUDIT_LOG
INSERT INTO AUDIT_LOG (user_id, action, table_affected) VALUES
(14, 'INSERT appointment for patient_id 5',          'APPOINTMENT'),
(2,  'UPDATE prescription status to Dispensed',      'PRESCRIPTION'),
(12, 'INSERT lab report for request_id 1',           'LAB_REPORT'),
(1,  'UPDATE medicine batch available_qty',          'MEDICINE_BATCH'),
(14, 'INSERT bill for patient_id 6',                 'BILL'),
(9,  'CANCELLED own appointment',                    'APPOINTMENT');
