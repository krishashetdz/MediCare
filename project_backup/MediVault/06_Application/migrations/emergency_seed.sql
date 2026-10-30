-- Seed initial Emergency cases and triage data
INSERT IGNORE INTO EMERGENCY_CASE 
(case_id, emg_number, patient_id, temp_patient_name, temp_patient_gender, temp_patient_age, arrival_time, arrival_method, ambulance_id, initial_complaint, triage_priority, status, assigned_doctor_id, assigned_bed_id, department_id)
VALUES
(1, 'EMG-2026-001', 5, NULL, NULL, NULL, DATE_SUB(NOW(), INTERVAL 45 MINUTE), 'Ambulance', 2, 'Acute chest pain radiating to left arm, shortness of breath, diaphoresis', 'P1', 'In Treatment', 2, 7, 1),
(2, 'EMG-2026-002', 7, NULL, NULL, NULL, DATE_SUB(NOW(), INTERVAL 30 MINUTE), 'Walk-in', NULL, 'Suspected tibial fracture from motorbike fall, severe swelling', 'P2', 'Assigned', 3, 8, 2),
(3, 'EMG-2026-003', NULL, 'Unknown Male', 'M', 35, DATE_SUB(NOW(), INTERVAL 20 MINUTE), 'Ambulance', 3, 'Unconscious on arrival, suspected head trauma, shallow breathing', 'P1', 'Waiting', NULL, NULL, 6),
(4, 'EMG-2026-004', 9, NULL, NULL, NULL, DATE_SUB(NOW(), INTERVAL 15 MINUTE), 'Walk-in', NULL, 'Persistent high grade fever (103°F) and dehydration', 'P3', 'Waiting', NULL, NULL, 3),
(5, 'EMG-2026-005', 10, NULL, NULL, NULL, DATE_SUB(NOW(), INTERVAL 5 MINUTE), 'Walk-in', NULL, 'Superficial laceration on forearm from broken glass, active bleeding stopped', 'P4', 'Waiting', NULL, NULL, 6);

-- Set assigned beds to Occupied
UPDATE BED SET status='Occupied', patient_id=5 WHERE bed_id=7;
UPDATE BED SET status='Occupied', patient_id=7 WHERE bed_id=8;

-- Insert initial triage assessments
INSERT IGNORE INTO TRIAGE_ASSESSMENT 
(case_id, nurse_id, bp_systolic, bp_diastolic, heart_rate, spo2, temperature, respiratory_rate, consciousness_level, gcs_score, priority, priority_reason, symptoms, injury_details, assessment_notes)
VALUES
(1, 11, 165, 105, 118, 91, 98.6, 26, 'Alert', 15, 'P1', 'Severe cardiac symptom presentation with desaturation', 'Crushing substernal chest pain, radiating to left shoulder and jaw, profuse sweating', 'No visible physical trauma', 'ECG ordered immediately. Stat cardiology evaluation requested. Oxygen initiated via nasal cannula.'),
(2, 11, 130, 85, 95, 98, 99.1, 18, 'Alert', 15, 'P2', 'Open deformity, severe pain score 8/10, neurovascular check intact', 'Inability to bear weight, visible deformity of right lower leg', 'Contusions and abrasion on right shin, palpable distal pulses intact', 'Splint applied, IV analgesia administered, X-ray ordered.'),
(3, 11, 90, 55, 130, 88, 97.4, 30, 'Pain', 8, 'P1', 'GCS 8, severe respiratory distress, hemodynamic instability', 'Unresponsive to verbal stimuli, reacts sluggishly to pain', 'Hematoma left temporal region, contusions on chest', 'Bag-valve-mask ventilatory support underway. Trauma team and airway activation stat.'),
(4, 11, 115, 75, 102, 97, 103.2, 20, 'Alert', 15, 'P3', 'High fever, tachycardia secondary to pyrexia, stable vitals', 'High fever x 3 days, chills, generalized weakness', 'No trauma', 'Paracetamol IV initiated, blood cultures and CBC drawn.'),
(5, 11, 120, 80, 78, 99, 98.4, 16, 'Alert', 15, 'P4', 'Minor soft tissue laceration, hemodynamically completely stable', 'Localized pain at left forearm laceration', '3 cm superficial clean cut left forearm, bleeding controlled', 'Wound irrigation and primary suture scheduled.');

-- Insert treatment logs for case 1 and 2
INSERT IGNORE INTO EMERGENCY_TREATMENT_LOG (case_id, doctor_id, action_type, description)
VALUES
(1, 2, 'Medication Administered', 'Aspirin 325mg chewable + Clopidogrel 300mg loading dose + Sublingual Nitroglycerin given.'),
(1, 2, 'Procedure', '12-lead ECG obtained showing ST-elevation in leads II, III, aVF. Activated Cath Lab.'),
(2, 3, 'Observation', 'Immobilized with posterior slab. Neurovascular status reassessed: pulse 2+, capillary refill < 2s.');

-- Seed a sample blood request
INSERT IGNORE INTO BLOOD_REQUEST (request_id, patient_id, case_id, requested_by, blood_group, units, priority, reason, status)
VALUES
(1, NULL, 3, 2, 'O-', 2, 'Emergency', 'Severe trauma with hemodynamic shock, emergent transfusion required', 'Pending');

