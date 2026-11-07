/**
 * test-e2e.js — MediVault / MediCare End-to-End Verification Suite
 *
 * To reset the database before re-running against a clean state:
 *   mysql -u root medivault < db/schema.sql && mysql -u root medivault < db/seed.sql
 *
 * Run under both IST and UTC timezones:
 *   TZ=Asia/Kolkata node test-e2e.js
 *   TZ=UTC node test-e2e.js
 */
const http = require('http');

const PORT = process.env.PORT || 3000;

// Compute a future date dynamically (14 days from today in local time)
function computeFutureDate(daysAhead = 14) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

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

    const futureDate = computeFutureDate(14);
    const runTag = Date.now().toString().slice(-6);

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
        const patEmail = `aarav.kulkarni.${runTag}@gmail.com`;
        const regPat = await recClient.request('POST', '/api/staff/receptionist/register-patient', {
            name: 'Aarav Kulkarni',
            email: patEmail,
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
            email: patEmail,
            password: 'aarav_secret_pw'
        });
        assert(loginNewPat.status === 200 && loginNewPat.data.user.role === 'Patient', 'Newly registered patient logs in via bcrypt');

        // Pick a free slot on futureDate for doctor_id=2
        const availRes = await patClient.request('GET', `/api/patient/available-slots?doctor_id=2&appointment_date=${futureDate}`);
        const primarySlot = Array.isArray(availRes.data) && availRes.data.length ? availRes.data[0] : '10:30:00';
        const secondarySlot = Array.isArray(availRes.data) && availRes.data.length > 1 ? availRes.data[1] : '11:00:00';
        const tertiarySlot = Array.isArray(availRes.data) && availRes.data.length > 2 ? availRes.data[2] : '11:30:00';

        const bookAppt = await patClient.request('POST', '/api/patient/book-appointment', {
            doctor_id: 2,
            appointment_date: futureDate,
            appointment_time: primarySlot
        });
        assert(bookAppt.status === 201, `Patient books appointment on ${futureDate} at ${primarySlot} via sp_book_appointment (3NF)`);

        const patAppts = await patClient.request('GET', '/api/patient/appointments');
        const bookedRow = Array.isArray(patAppts.data)
            ? patAppts.data.find(a => a.appointment_date === futureDate && a.appointment_time === primarySlot)
            : null;
        assert(
            Boolean(bookedRow && bookedRow.appointment_id && bookedRow.appointment_date === futureDate && bookedRow.department_name === 'Cardiology'),
            '3NF patient appointment query returns exact YYYY-MM-DD dateStrings and derives department_name via DOCTOR -> DEPARTMENT'
        );
        const newApptId = bookedRow.appointment_id;

        const dupAppt = await patClient.request('POST', '/api/patient/book-appointment', {
            doctor_id: 2,
            appointment_date: futureDate,
            appointment_time: primarySlot
        });
        assert(dupAppt.status === 409, 'Duplicate appointment slot rejected with 409 Conflict');

        // 2b. Receptionist Appointment Workflow Edges (Reschedule & Cancel)
        console.log('\n--- 2b. Receptionist Appointment Workflow Edges (Reschedule & Cancel) ---');
        const recBook2 = await recClient.request('POST', '/api/staff/receptionist/book-appointment', {
            patient_id: newPatientId,
            doctor_id: 2,
            department_id: 1,
            appointment_date: futureDate,
            appointment_time: secondarySlot
        });
        assert(recBook2.status === 201, `Receptionist books second appointment at ${secondarySlot}`);

        const recList = await recClient.request('GET', '/api/staff/receptionist/appointments');
        const secondApptRow = Array.isArray(recList.data)
            ? recList.data.find(a => a.patient_id === newPatientId && a.appointment_date === futureDate && a.appointment_time === secondarySlot && a.status === 'Scheduled')
            : null;
        const secondApptId = secondApptRow ? secondApptRow.appointment_id : null;

        const reschedTaken = await recClient.request('POST', `/api/staff/receptionist/appointments/${secondApptId}/reschedule`, {
            appointment_date: futureDate,
            appointment_time: primarySlot
        });
        assert(reschedTaken.status === 409, 'Receptionist reschedule to a taken slot returns 409 Conflict (and rolls back old slot cancellation)');

        const reschedFree = await recClient.request('POST', `/api/staff/receptionist/appointments/${secondApptId}/reschedule`, {
            appointment_date: futureDate,
            appointment_time: tertiarySlot
        });
        assert(
            reschedFree.status === 201 && reschedFree.data.appointment_id,
            `Receptionist reschedule to a free slot (${tertiarySlot}) succeeds inside transaction`
        );
        const rescheduledApptId = reschedFree.data.appointment_id;

        const recCancel = await recClient.request('POST', `/api/staff/receptionist/appointments/${rescheduledApptId}/cancel`, {});
        assert(recCancel.status === 200 && recCancel.data.status === 'Cancelled', 'Receptionist cancels appointment');

        const rebookFreedSlot = await recClient.request('POST', '/api/staff/receptionist/book-appointment', {
            patient_id: newPatientId,
            doctor_id: 2,
            department_id: 1,
            appointment_date: futureDate,
            appointment_time: tertiarySlot
        });
        assert(rebookFreedSlot.status === 201, 'Cancelling appointment frees the active slot for re-booking');

        // Clean up the rebooked test slot by cancelling it so only primarySlot remains active
        const recListAfter = await recClient.request('GET', '/api/staff/receptionist/appointments');
        const rebookedRow = Array.isArray(recListAfter.data)
            ? recListAfter.data.find(a => a.patient_id === newPatientId && a.appointment_date === futureDate && a.appointment_time === tertiarySlot && a.status === 'Scheduled')
            : null;
        if (rebookedRow) {
            await recClient.request('POST', `/api/staff/receptionist/appointments/${rebookedRow.appointment_id}/cancel`, {});
        }

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

        const reschedCompleted = await recClient.request('POST', `/api/staff/receptionist/appointments/${newApptId}/reschedule`, {
            appointment_date: futureDate,
            appointment_time: tertiarySlot
        });
        assert(reschedCompleted.status === 409, 'Block rescheduling Completed appointment (409)');

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

        const targetEmgBedId = prioEngine.data.recommended_bed.bed_id;
        const emgAlloc = await nurseClient.request('POST', `/api/emergency/allocate/${emgCaseId}`, {
            doctor_id: 2, // Allocate to Dr. Aditi Sharma (doc1Client)
            bed_id: targetEmgBedId,
            department_id: prioEngine.data.recommended_department.id
        });
        assert(emgAlloc.status === 200, 'Allocate doctor and Available bed in transaction');

        const dupBedAlloc = await nurseClient.request('POST', '/api/emergency/allocate/2', {
            doctor_id: 2,
            bed_id: targetEmgBedId
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

        // Mark emergency bed Available again so test is re-runnable
        await nurseClient.request('POST', `/api/staff/nurse/beds/${targetEmgBedId}/mark-available`);

        const ambComplete = await adminClient.request('POST', '/api/admin/ambulance/1/release');
        assert(ambComplete.status === 200, 'Release ambulance dispatch and return ambulance to Available');

        // 7. Admin Staff Creation (USER + STAFF transaction, duplicate email 409, non-admin 403)
        console.log('\n--- 7. Admin Staff Creation (USER + STAFF Transaction, Duplicate 409, Non-Admin 403) ---');
        const staffEmail = `meera.deshmukh.${runTag}@medivault.in`;
        const nonAdminStaffCreate = await recClient.request('POST', '/api/admin/staff', {
            name: 'Unauthorized Staff',
            email: `unauth.${runTag}@medivault.in`,
            password: 'staff_pw_123',
            role: 'Nurse',
            shift: 'Morning'
        });
        assert(nonAdminStaffCreate.status === 403, 'RBAC: Non-admin (Receptionist) blocked from POST /api/admin/staff (403)');

        const createStaffRes = await adminClient.request('POST', '/api/admin/staff', {
            name: 'Meera Deshmukh',
            email: staffEmail,
            phone: '9823099887',
            password: 'meera_staff_pw',
            role: 'Nurse',
            department_id: 1,
            shift: 'Evening'
        });
        assert(
            createStaffRes.status === 201 && createStaffRes.data.staff_id && createStaffRes.data.staff_type === 'NURSE',
            'Admin creates Nurse user (USER + STAFF rows in one transaction)'
        );

        const dupStaffEmail = await adminClient.request('POST', '/api/admin/staff', {
            name: 'Duplicate Staff',
            email: staffEmail,
            password: 'another_password',
            role: 'Pharmacist',
            shift: 'Morning'
        });
        assert(dupStaffEmail.status === 409, 'Duplicate staff email returns 409 Conflict');

        const newStaffClient = createClient();
        const loginNewStaff = await newStaffClient.request('POST', '/api/auth/login', {
            email: staffEmail,
            password: 'meera_staff_pw'
        });
        assert(loginNewStaff.status === 200 && loginNewStaff.data.user.role === 'Nurse', 'Newly created staff member logs in via bcrypt');

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
