-- MediVault Emergency & Extended Modules Schema Migration

-- 1. Ensure Emergency Department exists
INSERT IGNORE INTO DEPARTMENT (department_id, department_name, floor_no)
VALUES (6, 'Emergency Medicine', 1);

-- 2. Add Emergency Ward Beds if not already present
INSERT IGNORE INTO BED (ward_name, bed_number, status)
VALUES 
('Emergency Ward', 'E-01', 'Available'),
('Emergency Ward', 'E-02', 'Available'),
('Emergency Ward', 'E-03', 'Available'),
('Emergency Ward', 'E-04', 'Available'),
('Emergency Ward', 'E-05', 'Available'),
('Emergency Ward', 'E-06', 'Available');

-- 3. EMERGENCY_CASE Table
CREATE TABLE IF NOT EXISTS EMERGENCY_CASE (
    case_id INT AUTO_INCREMENT PRIMARY KEY,
    emg_number VARCHAR(30) NOT NULL UNIQUE,
    patient_id INT NULL,
    temp_patient_name VARCHAR(100) NULL,
    temp_patient_gender VARCHAR(10) NULL,
    temp_patient_age INT NULL,
    contact_phone VARCHAR(20) NULL,
    emergency_contact VARCHAR(100) NULL,
    arrival_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    arrival_method VARCHAR(50) NOT NULL DEFAULT 'Walk-in',
    ambulance_id INT NULL,
    initial_complaint TEXT NOT NULL,
    triage_priority VARCHAR(10) DEFAULT 'P3',
    status VARCHAR(30) NOT NULL DEFAULT 'Waiting',
    assigned_doctor_id INT NULL,
    assigned_bed_id INT NULL,
    department_id INT NULL,
    treatment_notes TEXT NULL,
    discharge_summary TEXT NULL,
    discharged_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_emg_status (status),
    INDEX idx_emg_priority (triage_priority),
    INDEX idx_emg_arrival (arrival_time),
    FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE SET NULL,
    FOREIGN KEY (ambulance_id) REFERENCES AMBULANCE(ambulance_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_bed_id) REFERENCES BED(bed_id) ON DELETE SET NULL,
    FOREIGN KEY (department_id) REFERENCES DEPARTMENT(department_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. TRIAGE_ASSESSMENT Table
CREATE TABLE IF NOT EXISTS TRIAGE_ASSESSMENT (
    assessment_id INT AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    nurse_id INT NULL,
    bp_systolic INT,
    bp_diastolic INT,
    heart_rate INT,
    spo2 INT,
    temperature DECIMAL(4,1),
    respiratory_rate INT,
    consciousness_level VARCHAR(20) DEFAULT 'Alert',
    gcs_score INT NULL,
    priority VARCHAR(10) NOT NULL,
    priority_reason TEXT NULL,
    symptoms TEXT,
    injury_details TEXT,
    assessment_notes TEXT,
    assessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_triage_case (case_id),
    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    FOREIGN KEY (nurse_id) REFERENCES USER(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. EMERGENCY_PRIORITY_LOG Table
CREATE TABLE IF NOT EXISTS EMERGENCY_PRIORITY_LOG (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    old_priority VARCHAR(10) NOT NULL,
    new_priority VARCHAR(10) NOT NULL,
    changed_by INT NULL,
    reason TEXT NOT NULL,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    FOREIGN KEY (changed_by) REFERENCES USER(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. DOCTOR_SHIFT Table
CREATE TABLE IF NOT EXISTS DOCTOR_SHIFT (
    shift_id INT AUTO_INCREMENT PRIMARY KEY,
    doctor_id INT NOT NULL,
    shift_date DATE NOT NULL,
    shift_type VARCHAR(20) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_on_duty BOOLEAN DEFAULT TRUE,
    INDEX idx_shift_doc_date (doctor_id, shift_date),
    FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. DOCTOR_LEAVE Table
CREATE TABLE IF NOT EXISTS DOCTOR_LEAVE (
    leave_id INT AUTO_INCREMENT PRIMARY KEY,
    doctor_id INT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    reason TEXT,
    status VARCHAR(20) DEFAULT 'Approved',
    approved_by INT NULL,
    INDEX idx_leave_doc (doctor_id, start_date, end_date),
    FOREIGN KEY (doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES USER(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. BLOOD_REQUEST Table
CREATE TABLE IF NOT EXISTS BLOOD_REQUEST (
    request_id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NULL,
    case_id INT NULL,
    requested_by INT NOT NULL,
    blood_group VARCHAR(3) NOT NULL,
    units INT NOT NULL,
    priority VARCHAR(20) DEFAULT 'Normal',
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Pending',
    approved_by INT NULL,
    fulfilled_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_blood_req_status (status),
    FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE SET NULL,
    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE SET NULL,
    FOREIGN KEY (requested_by) REFERENCES USER(user_id) ON DELETE CASCADE,
    FOREIGN KEY (approved_by) REFERENCES USER(user_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. PATIENT_VITALS Table
CREATE TABLE IF NOT EXISTS PATIENT_VITALS (
    vitals_id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NULL,
    case_id INT NULL,
    recorded_by INT NOT NULL,
    bp_systolic INT,
    bp_diastolic INT,
    heart_rate INT,
    spo2 INT,
    temperature DECIMAL(4,1),
    respiratory_rate INT,
    notes TEXT,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_vitals_patient (patient_id),
    INDEX idx_vitals_case (case_id),
    FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    FOREIGN KEY (recorded_by) REFERENCES USER(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. NURSE_NOTE Table
CREATE TABLE IF NOT EXISTS NURSE_NOTE (
    note_id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NULL,
    case_id INT NULL,
    bed_id INT NULL,
    nurse_id INT NOT NULL,
    note_type VARCHAR(30) DEFAULT 'General',
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_note_patient (patient_id),
    INDEX idx_note_case (case_id),
    FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    FOREIGN KEY (bed_id) REFERENCES BED(bed_id) ON DELETE SET NULL,
    FOREIGN KEY (nurse_id) REFERENCES USER(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. ADMISSION Table
CREATE TABLE IF NOT EXISTS ADMISSION (
    admission_id INT AUTO_INCREMENT PRIMARY KEY,
    patient_id INT NOT NULL,
    case_id INT NULL,
    admitting_doctor_id INT NOT NULL,
    ward_name VARCHAR(50) NOT NULL,
    bed_id INT NOT NULL,
    admitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    discharged_at DATETIME NULL,
    discharge_summary TEXT NULL,
    status VARCHAR(20) DEFAULT 'Admitted',
    INDEX idx_admission_patient (patient_id),
    INDEX idx_admission_status (status),
    FOREIGN KEY (patient_id) REFERENCES PATIENT(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE SET NULL,
    FOREIGN KEY (admitting_doctor_id) REFERENCES DOCTOR(doctor_id) ON DELETE CASCADE,
    FOREIGN KEY (bed_id) REFERENCES BED(bed_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. EMERGENCY_TREATMENT_LOG Table
CREATE TABLE IF NOT EXISTS EMERGENCY_TREATMENT_LOG (
    treatment_id INT AUTO_INCREMENT PRIMARY KEY,
    case_id INT NOT NULL,
    doctor_id INT NOT NULL,
    action_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    performed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (case_id) REFERENCES EMERGENCY_CASE(case_id) ON DELETE CASCADE,
    FOREIGN KEY (doctor_id) REFERENCES USER(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 13. Seed shifts for all doctors for today and next 7 days
INSERT IGNORE INTO DOCTOR_SHIFT (doctor_id, shift_date, shift_type, start_time, end_time, is_on_duty)
SELECT 
    d.doctor_id,
    CURDATE(),
    CASE 
        WHEN d.doctor_id % 3 = 0 THEN 'Morning'
        WHEN d.doctor_id % 3 = 1 THEN 'Evening'
        ELSE 'Night'
    END,
    '08:00:00',
    '16:00:00',
    TRUE
FROM DOCTOR d;

INSERT IGNORE INTO DOCTOR_SHIFT (doctor_id, shift_date, shift_type, start_time, end_time, is_on_duty)
SELECT 
    d.doctor_id,
    DATE_ADD(CURDATE(), INTERVAL 1 DAY),
    'Morning',
    '08:00:00',
    '16:00:00',
    TRUE
FROM DOCTOR d;

