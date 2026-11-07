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
