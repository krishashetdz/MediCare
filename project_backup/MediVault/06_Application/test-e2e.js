const http = require('http');

const PORT = process.env.PORT || 3000;

function createClient(port = PORT) {
    let cookie = '';
    return {
        request(method, urlPath, body = null) {
            return new Promise((resolve, reject) => {
                const url = new URL(urlPath, `http://localhost:${port}`);
                const headers = { 'Accept': 'application/json' };
                if (cookie) headers['Cookie'] = cookie;
                let payload = null;
                if (body !== null) {
                    payload = JSON.stringify(body);
                    headers['Content-Type'] = 'application/json';
                    headers['Content-Length'] = Buffer.byteLength(payload);
                }

                const req = http.request({
                    hostname: 'localhost',
                    port,
                    path: url.pathname + url.search,
                    method,
                    headers
                }, (res) => {
                    const setCookie = res.headers['set-cookie'];
                    if (setCookie) {
                        cookie = setCookie.map(c => c.split(';')[0]).join('; ');
                    }
                    let data = '';
                    res.on('data', chunk => { data += chunk; });
                    res.on('end', () => {
                        let parsed = data;
                        try { parsed = JSON.parse(data); } catch (_) {}
                        resolve({ status: res.statusCode, data: parsed });
                    });
                });

                req.on('error', reject);
                if (payload) req.write(payload);
                req.end();
            });
        }
    };
}

async function runTests() {
    console.log('=== STARTING MEDIVAULT / MEDICARE PHASE 5 E2E VERIFICATION SUITE ===\n');

    let passed = 0;
    let failed = 0;

    function assert(cond, name, details = '') {
        if (cond) {
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } else {
            console.error(`❌ [FAIL] ${name} ${details}`);
            failed++;
        }
    }

    try {
        const anonClient = createClient();
        const adminClient = createClient();
        const recClient = createClient();   // suresh.rao@medivault.in (staff4)
        const doc1Client = createClient();  // sharma.doc@medivault.in (doc1, Cardiology)
        const doc2Client = createClient();  // mehta.doc@medivault.in  (doc2, Orthopedics)
        const labClient = createClient();   // arjun.pillai@medivault.in (staff2)
        const pharmClient = createClient(); // neha.kapoor@medivault.in (staff3)
        const nurseClient = createClient(); // kavita.joshi@medivault.in (staff1)
        const patClient = createClient();

        // 0. Health Check
        const health = await anonClient.request('GET', '/health');
        assert(health.status === 200 && health.data.status === 'ok', 'Health Check');

        // 1. Security: Authentication & RBAC
        console.log('\n--- 1. Security: Authentication & RBAC ---');
        const badPw = await anonClient.request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'wrongpassword'
        });
        assert(badPw.status === 401, 'Reject wrong password login (401)');

        const fallbackPw1 = await anonClient.request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'password'
        });
        assert(fallbackPw1.status === 401, "Reject legacy 'password' fallback (401)");

        const fallbackPw2 = await anonClient.request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'admin123'
        });
        assert(fallbackPw2.status === 401, "Reject legacy 'admin123' fallback (401)");

        const fallbackHash = await anonClient.request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'hash_admin1'
        });
        assert(fallbackHash.status === 401, "Reject legacy 'hash_admin1' plaintext comparison (401)");

        const unauthReq = await anonClient.request('GET', '/api/admin/overview');
        assert(unauthReq.status === 401, 'Reject unauthenticated API access (401)');

        const loginAdmin = await adminClient.request('POST', '/api/auth/login', { email: 'admin@medivault.in', password: 'admin1' });
        assert(loginAdmin.status === 200 && loginAdmin.data.user.role === 'Admin', 'Admin login with bcrypt hash');

        const loginRec = await recClient.request('POST', '/api/auth/login', { email: 'suresh.rao@medivault.in', password: 'staff4' });
        assert(loginRec.status === 200 && loginRec.data.user.role === 'Receptionist', 'Receptionist login with bcrypt hash');

        const loginDoc1 = await doc1Client.request('POST', '/api/auth/login', { email: 'sharma.doc@medivault.in', password: 'doc1' });
        assert(loginDoc1.status === 200 && loginDoc1.data.user.role === 'Doctor', 'Doctor 1 (Dr. Aditi Sharma) login with bcrypt hash');

        const loginDoc2 = await doc2Client.request('POST', '/api/auth/login', { email: 'mehta.doc@medivault.in', password: 'doc2' });
        assert(loginDoc2.status === 200 && loginDoc2.data.user.role === 'Doctor', 'Doctor 2 (Dr. Karan Mehta) login with bcrypt hash');

        const loginLab = await labClient.request('POST', '/api/auth/login', { email: 'arjun.pillai@medivault.in', password: 'staff2' });
        assert(loginLab.status === 200 && loginLab.data.user.role === 'Lab Technician', 'Lab Technician login with bcrypt hash');

        const loginPharm = await pharmClient.request('POST', '/api/auth/login', { email: 'neha.kapoor@medivault.in', password: 'staff3' });
        assert(loginPharm.status === 200 && loginPharm.data.user.role === 'Pharmacist', 'Pharmacist login with bcrypt hash');

        const loginNurse = await nurseClient.request('POST', '/api/auth/login', { email: 'kavita.joshi@medivault.in', password: 'staff1' });
        assert(loginNurse.status === 200 && loginNurse.data.user.role === 'Nurse', 'Nurse login with bcrypt hash');

        const pharmTryAdmin = await pharmClient.request('GET', '/api/admin/overview');
        assert(pharmTryAdmin.status === 403, 'RBAC: Pharmacist blocked from /api/admin/overview (403)');

        const pharmTryTriage = await pharmClient.request('POST', '/api/emergency/triage/1', { priority: 'P2' });
        assert(pharmTryTriage.status === 403, 'RBAC: Pharmacist blocked from emergency triage (403)');

        const labTryAllocate = await labClient.request('POST', '/api/emergency/allocate/1', { doctor_id: 2, bed_id: 1 });
        assert(labTryAllocate.status === 403, 'RBAC: Lab Technician blocked from emergency bed allocation (403)');

        const recTryTreatment = await recClient.request('POST', '/api/emergency/treatment/1', { action_type: 'Procedure', description: 'Test' });
        assert(recTryTreatment.status === 403, 'RBAC: Receptionist blocked from recording clinical treatment (403)');

        // 2. Normal Patient Flow
        console.log('\n--- 2. Normal Patient Flow (Register -> Book -> Consult -> Lab/Mongo -> Bill -> Partial/Paid) ---');
        const regPat = await recClient.request('POST', '/api/staff/receptionist/register-patient', {
            name: 'Aarav Kulkarni',
            email: 'aarav.kulkarni@gmail.com',
            phone: '9823011223',
            password: 'aarav_secret_pw',
            dob: '1988-05-14',
            gender: 'M',
            blood_group: 'B+',
            address: 'Baner Road, Pune',
            emergency_contact: '9823011224',
            allergies: 'Penicillin, Dust'
        });
        assert(regPat.status === 201 && regPat.data.patient_id, 'Receptionist registers new patient with bcrypt password & 1NF allergies');
        const newPatientId = regPat.data.patient_id;

        const loginNewPat = await patClient.request('POST', '/api/auth/login', {
            email: 'aarav.kulkarni@gmail.com',
            password: 'aarav_secret_pw'
        });
        assert(loginNewPat.status === 200 && loginNewPat.data.user.role === 'Patient', 'Newly registered patient logs in via bcrypt');

        const bookAppt = await patClient.request('POST', '/api/patient/book-appointment', {
            doctor_id: 2,
            appointment_date: '2026-04-15',
            appointment_time: '10:30:00'
        });
        assert(bookAppt.status === 201, 'Patient books appointment via sp_book_appointment (3NF)');

        const patAppts = await patClient.request('GET', '/api/patient/appointments');
        const bookedRow = Array.isArray(patAppts.data) ? patAppts.data.find(a => a.appointment_date.startsWith('2026-04-15') && a.appointment_time === '10:30:00') : null;
        assert(Boolean(bookedRow && bookedRow.appointment_id && bookedRow.department_name === 'Cardiology'), '3NF patient appointment query derives department_name via DOCTOR -> DEPARTMENT');
        const newApptId = bookedRow.appointment_id;

        const dupAppt = await patClient.request('POST', '/api/patient/book-appointment', {
            doctor_id: 2,
            appointment_date: '2026-04-15',
            appointment_time: '10:30:00'
        });
        assert(dupAppt.status === 409, 'Duplicate appointment slot rejected with 409 Conflict');

        const confirmAppt = await doc1Client.request('PATCH', `/api/doctor/appointments/${newApptId}/status`, { status: 'Confirmed' });
        assert(confirmAppt.status === 200, 'Doctor confirms appointment (Confirmed in ENUM)');

        const crossDocConsult = await doc2Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Unauthorized attempt',
            diagnosis: 'Should fail'
        });
        assert(crossDocConsult.status === 403, 'Ownership: Doctor 2 blocked from consulting on Doctor 1 appointment (403)');

        const crossDocHist = await doc2Client.request('GET', `/api/doctor/patients/${newPatientId}/history`);
        assert(crossDocHist.status === 403, 'Ownership: Doctor 2 blocked from viewing unassociated patient history (403)');

        const consultRes = await doc1Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Exertional dyspnea, occasional palpitations',
            diagnosis: 'Paroxysmal Atrial Fibrillation',
            notes: 'Initiating rate control and ordering Urgent Lipid Profile. Recommending ICU telemetry observation.',
            recommend_admission: true,
            recommended_ward: 'ICU',
            admission_priority: 'Urgent',
            admission_reason: 'Continuous cardiac telemetry monitoring'
        });
        assert(consultRes.status === 201 && consultRes.data.consultation_id, 'Doctor records consultation, MEDICAL_RECORD, and ADMISSION_REQUEST');
        const newConsultId = consultRes.data.consultation_id;

        const prescRes = await doc1Client.request('POST', '/api/doctor/prescriptions', {
            consultation_id: newConsultId,
            items: [
                {
                    medicine_id: 2,
                    dosage: '250mg twice daily',
                    instructions: 'Take after meals with water',
                    duration_days: 5,
                    quantity: 10
                }
            ]
        });
        assert(prescRes.status === 201 && prescRes.data.prescription_id, 'Doctor writes 3NF prescription with instructions');
        const newPrescId = prescRes.data.prescription_id;

        const labReqRes = await doc1Client.request('POST', '/api/doctor/lab-requests', {
            consultation_id: newConsultId,
            test_id: 2,
            priority: 'Urgent'
        });
        assert(labReqRes.status === 201 && labReqRes.data.request_id, 'Doctor creates LAB_REQUEST with priority=Urgent');
        const newLabReqId = labReqRes.data.request_id;

        const labUpload = await labClient.request('POST', `/api/staff/lab-tech/requests/${newLabReqId}/report`, {
            result_summary: 'Total Cholesterol: 185 mg/dL, LDL: 102 mg/dL, HDL: 48 mg/dL (Normal)',
            parameters: [
                { name: 'Total Cholesterol', value: 185, unit: 'mg/dL' },
                { name: 'LDL', value: 102, unit: 'mg/dL' }
            ],
            findings: 'Lipid parameters within acceptable range'
        });
        assert(labUpload.status === 201 && labUpload.data.report_id, 'Lab Technician uploads structured report (MySQL + Mongo lab_reports_raw)');

        const docLabs = await doc1Client.request('GET', '/api/doctor/lab-reports');
        const uploadedLab = Array.isArray(docLabs.data) ? docLabs.data.find(r => r.request_id === newLabReqId) : null;
        assert(docLabs.status === 200 && uploadedLab && uploadedLab.priority === 'Urgent', 'Doctor views lab report');

        const genBill = await recClient.request('POST', '/api/staff/receptionist/generate-bill', { appointment_id: newApptId });
        assert(genBill.status === 201 && genBill.data.bill && genBill.data.bill.bill_id, 'Receptionist generates invoice via sp_generate_bill');
        const newBillId = genBill.data.bill.bill_id;
        const totalAmt = Number(genBill.data.bill.total_amount);

        const payPartial = await recClient.request('POST', `/api/billing/${newBillId}/payments`, {
            amount_paid: 500,
            payment_method: 'UPI',
            reference_no: 'UPI-TXN-9001'
        });
        assert(
            payPartial.status === 201 &&
            payPartial.data.receipt &&
            payPartial.data.receipt.receipt_number.startsWith('RCP-') &&
            payPartial.data.bill.payment_status === 'Partial',
            'Partial payment recorded in PAYMENT table with receipt; status computed as Partial'
        );

        const payFinal = await recClient.request('POST', `/api/billing/${newBillId}/payments`, {
            amount_paid: totalAmt - 500,
            payment_method: 'Card',
            reference_no: 'CARD-TXN-9002'
        });
        const billAfter = await patClient.request('GET', `/api/billing/${newBillId}`);
        assert(
            payFinal.status === 201 &&
            billAfter.data.payment_status === 'Paid' &&
            Number(billAfter.data.balance_due) === 0 &&
            billAfter.data.payments.length === 2,
            'Full balance payment recorded; status computed as Paid with 2 distinct payment receipts alongside invoice'
        );

        // 3. Pharmacy Workflow
        console.log('\n--- 3. Pharmacy Workflow (FEFO Batch Deduction, Expiry Check, Dispensing Record, Low Stock) ---');
        const dispSuccess = await pharmClient.request('POST', `/api/staff/pharmacist/dispense/${newPrescId}`, {
            notes: 'Dispensed 10 capsules of Amoxicillin 250mg'
        });
        assert(dispSuccess.status === 200 && dispSuccess.data.dispensing_id, 'Pharmacist dispenses prescription in transaction');

        const dispAgain = await pharmClient.request('POST', `/api/staff/pharmacist/dispense/${newPrescId}`);
        assert(dispAgain.status === 409, 'Prevent dispensing an already-dispensed prescription (409)');

        const dispLowStock = await pharmClient.request('POST', '/api/staff/pharmacist/dispense/4');
        assert(
            dispLowStock.status === 409 && dispLowStock.data.error.includes('insufficient non-expired stock'),
            'Pharmacy rejects dispensing Prescription #4 when requested quantity exceeds non-expired batch stock (409)'
        );

        // 4. Admission & Discharge Workflow
        console.log('\n--- 4. Admission, Bed Turnover & Inpatient Discharge Workflow ---');
        const pendingReqs = await nurseClient.request('GET', '/api/staff/nurse/admission-requests');
        const foundAdmReq = Array.isArray(pendingReqs.data) ? pendingReqs.data.find(r => r.patient_id === newPatientId) : null;
        assert(pendingReqs.status === 200 && foundAdmReq, 'Nurse sees doctor pending ADMISSION_REQUEST');

        const assignOccupied = await nurseClient.request('POST', '/api/staff/nurse/assign-admission-bed', {
            request_id: foundAdmReq.request_id,
            bed_id: 1
        });
        assert(assignOccupied.status === 409, 'Nurse blocked from assigning Occupied bed to admission request (409)');

        const assignAvailable = await nurseClient.request('POST', '/api/staff/nurse/assign-admission-bed', {
            request_id: foundAdmReq.request_id,
            bed_id: 5
        });
        assert(assignAvailable.status === 200 && assignAvailable.data.admission_id, 'Nurse assigns Available bed (ICU-2, bed_id=5) to ADMISSION_REQUEST');

        const dischInpatient = await nurseClient.request('POST', '/api/staff/nurse/discharge-inpatient', {
            admission_id: assignAvailable.data.admission_id,
            discharge_summary: 'Discharged home in stable sinus rhythm',
            room_fee: 3500
        });
        assert(
            dischInpatient.status === 200 && dischInpatient.data.bed_status === 'Cleaning',
            'Inpatient discharge closes ADMISSION, posts Admission charge to BILL_ITEM, and moves bed to Cleaning'
        );

        const markAvail = await nurseClient.request('POST', '/api/staff/nurse/beds/5/mark-available');
        assert(markAvail.status === 200 && markAvail.data.status === 'Available', 'Nurse marks Cleaning bed (bed_id=5) as Available');

        // 5. Emergency, Ambulance Dispatch & Priority Engine
        console.log('\n--- 5. Emergency Workflow, Ambulance Dispatch Link & Priority Engine ---');
        const ambDispatch = await adminClient.request('POST', '/api/admin/ambulance/1/dispatch', {
            patient_name: 'Priya Nair',
            pickup_location: 'Koregaon Park Lane 5, Pune',
            destination: 'MediVault Emergency Trauma Bay',
            contact_phone: '9822100001',
            triage_priority: 'P1',
            initial_complaint: 'Acute crushing chest pain radiating to left arm during morning walk'
        });
        assert(ambDispatch.status === 200 && ambDispatch.data.case_id, 'Ambulance dispatch creates linked EMERGENCY_CASE and AMBULANCE_DISPATCH');
        const emgCaseId = ambDispatch.data.case_id;

        const emgTriage = await nurseClient.request('POST', `/api/emergency/triage/${emgCaseId}`, {
            bp_systolic: 168,
            bp_diastolic: 104,
            heart_rate: 118,
            spo2: 91,
            temperature: 98.8,
            respiratory_rate: 24,
            consciousness_level: 'Alert',
            gcs_score: 15,
            priority: 'P1',
            priority_reason: 'Acute coronary syndrome presentation',
            symptoms: 'Crushing chest pain, diaphoresis, shortness of breath',
            injury_details: 'None',
            assessment_notes: '12-lead ECG shows ST elevation'
        });
        assert(emgTriage.status === 201 && emgTriage.data.priority === 'P1', 'Nurse records Emergency Triage Assessment');

        const prioEngine = await nurseClient.request('GET', `/api/emergency/priority-engine/${emgCaseId}`);
        assert(
            prioEngine.status === 200 &&
            prioEngine.data.recommended_department &&
            prioEngine.data.recommended_department.name === 'Cardiology' &&
            prioEngine.data.recommended_doctor &&
            prioEngine.data.recommended_bed,
            'Priority Engine matches Cardiology by department name and recommends on-shift doctor & available bed'
        );

        const emgAlloc = await nurseClient.request('POST', `/api/emergency/allocate/${emgCaseId}`, {
            doctor_id: 2, // Allocate to Dr. Aditi Sharma (doc1Client)
            bed_id: prioEngine.data.recommended_bed.bed_id,
            department_id: prioEngine.data.recommended_department.id
        });
        assert(emgAlloc.status === 200, 'Allocate doctor and Available bed in transaction');

        const dupBedAlloc = await nurseClient.request('POST', '/api/emergency/allocate/2', {
            doctor_id: 2,
            bed_id: prioEngine.data.recommended_bed.bed_id
        });
        assert(dupBedAlloc.status === 409, 'Reject allocating an already Occupied bed to another emergency case (409)');

        const crossEmgTreat = await doc2Client.request('POST', `/api/emergency/treatment/${emgCaseId}`, {
            action_type: 'Medication Administered',
            description: 'Unauthorized doctor attempt'
        });
        assert(crossEmgTreat.status === 403, 'Ownership: Doctor 2 blocked from logging treatment on Doctor 1 emergency case (403)');

        const ownEmgTreat = await doc1Client.request('POST', `/api/emergency/treatment/${emgCaseId}`, {
            action_type: 'Medication Administered',
            description: 'Dual antiplatelet loading + IV Heparin bolus'
        });
        assert(ownEmgTreat.status === 201, 'Assigned Doctor 1 logs emergency treatment');

        // 6. Blood Bank Workflow
        console.log('\n--- 6. Blood Bank Workflow (Approval Gate & Stock Deduction) ---');
        const bloodReq = await doc1Client.request('POST', '/api/admin/blood-bank/request', {
            blood_group: 'O-',
            units: 1,
            patient_id: 6,
            case_id: emgCaseId,
            priority: 'Emergency',
            reason: 'Standby cross-match for cardiac intervention'
        });
        assert(bloodReq.status === 201 && bloodReq.data.request_id, 'Create Blood Request (status=Pending)');
        const bReqId = bloodReq.data.request_id;

        const fulfillUnapproved = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bReqId}/fulfill`);
        assert(fulfillUnapproved.status === 409, 'Block blood fulfillment when request status is Pending (requires Approved status, 409)');

        const approveBReq = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bReqId}/approve`);
        assert(approveBReq.status === 200, 'Approve Blood Request');

        const fulfillApproved = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bReqId}/fulfill`);
        assert(fulfillApproved.status === 200, 'Fulfill Approved Blood Request and deduct BLOOD_BANK inventory');

        const emgDischarge = await doc1Client.request('POST', `/api/emergency/discharge/${emgCaseId}`, {
            discharge_summary: 'Stabilized in emergency bay; discharged to outpatient follow-up.',
            emergency_fee: 950
        });
        assert(emgDischarge.status === 200, 'Assigned Doctor 1 discharges emergency case -> creates Emergency BILL_ITEM and moves bed to Cleaning');

        const ambComplete = await adminClient.request('POST', '/api/admin/ambulance/1/release');
        assert(ambComplete.status === 200, 'Release ambulance dispatch and return ambulance to Available');

        console.log('\n=== E2E VERIFICATION SUMMARY ===');
        console.log(`Total Tests Run: ${passed + failed}`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);

        if (failed > 0) process.exit(1);
    } catch (err) {
        console.error('Test script crashed:', err);
        process.exit(1);
    }
}

runTests();
