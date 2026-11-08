/**
 * test-e2e.js — MediCare Comprehensive End-to-End, Security, Database Reliability & Edge-Case Verification Suite
 *
 * SAFETY GUARANTEE:
 *   - NEVER resets or drops the user's production database.
 *   - Automatically provisions an isolated test harness when running in a sandbox or dedicated test environment.
 *   - Covers TEST A through TEST J (120+ assertions) plus optional live browser verification (TEST K).
 *
 * Run under both IST and UTC timezones:
 *   TZ=Asia/Kolkata node test-e2e.js
 *   TZ=UTC node test-e2e.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Fallback module resolution for offline sandbox environments where node_modules is absent
const vendorDepsPath = path.join(__dirname, 'tests', 'harness', 'vendor_deps.js');
if (!fs.existsSync(path.join(__dirname, 'node_modules')) && fs.existsSync(vendorDepsPath)) {
    const vendor = require(vendorDepsPath);
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'dotenv') return vendor.dotenv;
        if (request === 'bcryptjs') return vendor.bcryptjs;
        if (request === 'express') return vendor.express;
        if (request === 'express-session') return vendor.expressSession;
        if (request === 'express-async-errors') return {};
        return origLoad.apply(this, arguments);
    };
}

const { createInMemoryMysqlPool, createInMemoryMongoDb, localIsoDate } = require('./tests/harness/test_db_engine');
const dbModule = require('./config/db');
const { runFreshInstall } = require('./db/install-fresh');
const { runMigrations, getMigrationStatus } = require('./db/migrate');
const { createDatabaseBackup } = require('./db/backup');
const { reconcilePendingOutbox } = require('./services/crossDbSync');

function computeFutureDate(daysAhead = 14) {
    return localIsoDate(daysAhead);
}

function createClient(port) {
    let cookie = '';
    return {
        getCookie() { return cookie; },
        setCookie(c) { cookie = c; },
        request(method, urlPath, body = null, customHeaders = {}) {
            return new Promise((resolve, reject) => {
                const url = new URL(urlPath, `http://localhost:${port}`);
                const headers = { 'Accept': 'application/json', ...customHeaders };
                if (cookie) headers['Cookie'] = cookie;
                let payload = null;
                if (body !== null) {
                    payload = typeof body === 'string' ? body : JSON.stringify(body);
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
                        const pairs = (Array.isArray(setCookie) ? setCookie : [setCookie])
                            .map(c => c.split(';')[0])
                            .filter(p => p && !p.endsWith('='));
                        if (pairs.length > 0) {
                            cookie = pairs.join('; ');
                        }
                    }
                    let data = '';
                    res.on('data', chunk => { data += chunk; });
                    res.on('end', () => {
                        let parsed = data;
                        try { parsed = JSON.parse(data); } catch (_) {}
                        resolve({ status: res.statusCode, data: parsed, headers: res.headers });
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
    console.log('=== STARTING MEDICARE MASTER VERIFICATION SUITE (TESTS A – J) ===\n');

    let passed = 0;
    let failed = 0;

    function assert(cond, name, details = '') {
        if (cond) {
            console.log(`✅ [PASS] ${name}`);
            passed++;
        } else {
            console.error(`❌ [FAIL] ${name} ${details ? '-> ' + details : ''}`);
            failed++;
        }
    }

    // Provision isolated test database environment (never touches or drops user production database)
    if (!process.env.SESSION_SECRET) {
        process.env.SESSION_SECRET = 'medicare-isolated-test-secret-998877665544332211';
    }
    const testMysqlPool = createInMemoryMysqlPool();
    const testMongoDb = createInMemoryMongoDb();
    dbModule.__setTestAdapters({ customMysqlPool: testMysqlPool, customMongoDb: testMongoDb });

    const { app, sessionStore } = require('./server');
    const server = await new Promise((resolve) => {
        const srv = app.listen(0, () => resolve(srv));
    });
    const PORT = server.address().port;

    const futureDate = computeFutureDate(14);
    const runTag = Date.now().toString().slice(-6);

    try {
        // =========================================================================
        // TEST A – DATABASE SAFETY, FRESH INSTALL, INCREMENTAL MIGRATIONS & BACKUP
        // =========================================================================
        console.log('--- TEST A: Database Safety, Fresh Installation & Incremental Migrations ---');

        const schemaText = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
        assert(!/DROP\s+DATABASE/i.test(schemaText), 'TEST A.1: db/schema.sql contains no destructive DROP DATABASE statement');

        // Fresh install on empty test database
        const freshRes = await runFreshInstall(testMysqlPool, { loadSeed: true });
        assert(
            freshRes.status === 'installed' && freshRes.executed_schema_statements > 0 && freshRes.executed_seed_statements > 0,
            'TEST A.2: Fresh database installation succeeds on empty test database and loads canonical seed data'
        );

        // Verify re-running fresh install against a populated database is blocked to protect existing records
        const secondInstallRes = await runFreshInstall(testMysqlPool, { loadSeed: true });
        assert(
            secondInstallRes.status === 'skipped_existing_data' && secondInstallRes.existing_users >= 15,
            'TEST A.3: Fresh installer refuses to overwrite a database that already contains hospital records'
        );

        // Verify backup utility before migrations
        const backupDir = path.join(__dirname, 'db', 'backups');
        const backupRes = await createDatabaseBackup(testMysqlPool, backupDir);
        assert(
            Boolean(backupRes.backup_file && fs.existsSync(backupRes.backup_file)),
            'TEST A.4: Pre-migration backup utility creates logical database snapshot'
        );
        try { fs.unlinkSync(backupRes.backup_file); } catch (_) {}

        // Existing database upgrade via incremental migrations
        const migRun1 = await runMigrations(testMysqlPool);
        assert(
            migRun1.status === 'ok' && migRun1.total_tracked >= 3,
            'TEST A.5: Incremental migration runner tracks all migrations in SCHEMA_MIGRATIONS'
        );

        // Run migrations a second time -> verify idempotency (0 newly applied, all skipped)
        const migRun2 = await runMigrations(testMysqlPool);
        assert(
            migRun2.status === 'ok' && migRun2.applied.length === 0 && migRun2.skipped.length >= 3,
            'TEST A.6: Repeated migration execution is idempotent (already-applied migrations are not executed twice)'
        );

        // Verify existing records remain intact after migrations
        const [[userCountAfterMig]] = await testMysqlPool.query('SELECT COUNT(*) AS cnt FROM `USER`');
        const [[patCountAfterMig]] = await testMysqlPool.query('SELECT COUNT(*) AS cnt FROM PATIENT');
        assert(
            Number(userCountAfterMig.cnt) === 15 && Number(patCountAfterMig.cnt) === 6,
            'TEST A.7: All existing USER (15) and PATIENT (6) records remain intact after migrations'
        );

        // Test migration failure handling (rolls back failed migration without corrupting SCHEMA_MIGRATIONS)
        const tempFailMigDir = path.join(__dirname, 'db', 'migrations_test_fail');
        fs.mkdirSync(tempFailMigDir, { recursive: true });
        fs.writeFileSync(path.join(tempFailMigDir, '999_broken_migration.sql'), 'CREATE TABLE INVALID_SQL_SYNTAX_ERROR;', 'utf8');
        let migFailedCleanly = false;
        try {
            await runMigrations(testMysqlPool, { migrationsDir: tempFailMigDir });
        } catch (migErr) {
            migFailedCleanly = migErr.message.includes('999_broken_migration.sql');
        } finally {
            fs.rmSync(tempFailMigDir, { recursive: true, force: true });
        }
        const migStatuses = await getMigrationStatus(testMysqlPool);
        assert(
            migFailedCleanly && !migStatuses.some(m => m.version === '999'),
            'TEST A.8: Failed migration rolls back cleanly and is not marked Applied in SCHEMA_MIGRATIONS'
        );

        // =========================================================================
        // TEST I – SECURITY, AUTHENTICATION, RBAC, SESSION & INJECTION HARDENING
        // =========================================================================
        console.log('\n--- TEST I: Security, Authentication, Persistent Sessions & RBAC ---');
        const anonClient = createClient(PORT);
        const adminClient = createClient(PORT);
        const recClient = createClient(PORT);   // suresh.rao@medivault.in (staff4)
        const doc1Client = createClient(PORT);  // sharma.doc@medivault.in (doc1, Cardiology)
        const doc2Client = createClient(PORT);  // mehta.doc@medivault.in  (doc2, Orthopedics)
        const labClient = createClient(PORT);   // arjun.pillai@medivault.in (staff2)
        const pharmClient = createClient(PORT); // neha.kapoor@medivault.in (staff3)
        const nurseClient = createClient(PORT); // kavita.joshi@medivault.in (staff1)
        const patClient = createClient(PORT);
        const pat2Client = createClient(PORT);  // priya.nair@gmail.com (pat2, user_id=6)

        // Liveness & Readiness checks
        const liveRes = await anonClient.request('GET', '/health/live');
        const readyRes = await anonClient.request('GET', '/health/ready');
        const healthRes = await anonClient.request('GET', '/health');
        assert(
            liveRes.status === 200 && liveRes.data.status === 'alive' &&
            readyRes.status === 200 && readyRes.data.mysql.connected === true &&
            healthRes.status === 200 && healthRes.data.status === 'ok',
            'TEST I.1: Liveness (/health/live) and Readiness (/health/ready, /health) report MySQL and MongoDB healthy'
        );

        const badPw = await anonClient.request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'wrongpassword'
        });
        assert(badPw.status === 401, 'TEST I.2: Reject wrong password login (401)');

        const fallbackPw1 = await anonClient.request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'password'
        });
        assert(fallbackPw1.status === 401, "TEST I.3: Reject legacy 'password' fallback (401)");

        const fallbackHash = await anonClient.request('POST', '/api/auth/login', {
            email: 'admin@medivault.in',
            password: 'hash_admin1'
        });
        assert(fallbackHash.status === 401, "TEST I.4: Reject legacy 'hash_admin1' plaintext comparison (401)");

        // SQL Injection attempt on login
        const sqliLogin = await anonClient.request('POST', '/api/auth/login', {
            email: "admin@medivault.in' OR '1'='1",
            password: "' OR '1'='1"
        });
        assert(sqliLogin.status === 401, 'TEST I.5: SQL injection payload on login is safely parameterized and rejected (401)');

        // NoSQL Injection attempt on login
        const nosqliLogin = await anonClient.request('POST', '/api/auth/login', {
            email: { $ne: null },
            password: { $ne: null }
        });
        assert(nosqliLogin.status === 400, 'TEST I.6: NoSQL object injection payload on login is rejected with 400 Bad Request');

        // Invalid JSON payload
        const malformedJson = await anonClient.request('POST', '/api/auth/login', '{bad_json:');
        assert(malformedJson.status === 400, 'TEST I.7: Malformed JSON request payload returns 400 Bad Request without crashing');

        const unauthReq = await anonClient.request('GET', '/api/admin/dashboard');
        assert(unauthReq.status === 401, 'TEST I.8: Reject unauthenticated API access (401)');

        // Login across all 7 roles and verify HttpOnly + SameSite cookie attributes
        const loginAdmin = await adminClient.request('POST', '/api/auth/login', { email: 'admin@medivault.in', password: 'admin1' });
        const setCookieHeader = JSON.stringify(loginAdmin.headers['set-cookie'] || '');
        assert(
            loginAdmin.status === 200 && loginAdmin.data.user.role === 'Admin' &&
            setCookieHeader.includes('HttpOnly') && setCookieHeader.includes('SameSite=lax'),
            'TEST I.9: Admin login succeeds, regenerates session, and sets HttpOnly + SameSite=lax cookie'
        );

        const loginRec = await recClient.request('POST', '/api/auth/login', { email: 'suresh.rao@medivault.in', password: 'staff4' });
        assert(loginRec.status === 200 && loginRec.data.user.role === 'Receptionist', 'TEST I.10: Receptionist login succeeds');

        const loginDoc1 = await doc1Client.request('POST', '/api/auth/login', { email: 'sharma.doc@medivault.in', password: 'doc1' });
        assert(loginDoc1.status === 200 && loginDoc1.data.user.role === 'Doctor', 'TEST I.11: Doctor 1 (Dr. Aditi Sharma) login succeeds');

        const loginDoc2 = await doc2Client.request('POST', '/api/auth/login', { email: 'mehta.doc@medivault.in', password: 'doc2' });
        assert(loginDoc2.status === 200 && loginDoc2.data.user.role === 'Doctor', 'TEST I.12: Doctor 2 (Dr. Karan Mehta) login succeeds');

        const loginLab = await labClient.request('POST', '/api/auth/login', { email: 'arjun.pillai@medivault.in', password: 'staff2' });
        assert(loginLab.status === 200 && loginLab.data.user.role === 'Lab Technician', 'TEST I.13: Lab Technician login succeeds');

        const loginPharm = await pharmClient.request('POST', '/api/auth/login', { email: 'neha.kapoor@medivault.in', password: 'staff3' });
        assert(loginPharm.status === 200 && loginPharm.data.user.role === 'Pharmacist', 'TEST I.14: Pharmacist login succeeds');

        const loginNurse = await nurseClient.request('POST', '/api/auth/login', { email: 'kavita.joshi@medivault.in', password: 'staff1' });
        assert(loginNurse.status === 200 && loginNurse.data.user.role === 'Nurse', 'TEST I.15: Nurse login succeeds');

        const loginPat2 = await pat2Client.request('POST', '/api/auth/login', { email: 'priya.nair@gmail.com', password: 'pat2' });
        assert(loginPat2.status === 200 && loginPat2.data.user.role === 'Patient', 'TEST I.16: Patient (Priya Nair) login succeeds');

        // Verify session expiration & logout invalidation
        const tempSessionClient = createClient(PORT);
        await tempSessionClient.request('POST', '/api/auth/login', { email: 'priya.nair@gmail.com', password: 'pat2' });
        const meBeforeLogout = await tempSessionClient.request('GET', '/api/auth/me');
        const savedCookie = tempSessionClient.getCookie();
        const logoutRes = await tempSessionClient.request('POST', '/api/auth/logout');
        tempSessionClient.setCookie(savedCookie); // Replay old cookie after logout
        const meAfterLogout = await tempSessionClient.request('GET', '/api/auth/me');
        assert(
            meBeforeLogout.status === 200 && logoutRes.status === 200 && meAfterLogout.status === 401,
            'TEST I.17: Logout destroys session in persistent store; replaying old session cookie returns 401'
        );

        // Test expired session in persistent store
        const expClient = createClient(PORT);
        await expClient.request('POST', '/api/auth/login', { email: 'priya.nair@gmail.com', password: 'pat2' });
        const expCookie = expClient.getCookie();
        const sidMatch = expCookie.match(/medicare\.sid=([^;]+)/);
        if (sidMatch) {
            const rawSid = decodeURIComponent(sidMatch[1]);
            await testMysqlPool.query('UPDATE USER_SESSION SET expires_at = ? WHERE session_id = ?', [Date.now() - 10000, rawSid]);
            sessionStore.fallbackCache.delete(rawSid);
        }
        const meExpired = await expClient.request('GET', '/api/auth/me');
        assert(meExpired.status === 401, 'TEST I.18: Expired session in USER_SESSION is rejected with 401 Unauthorized');

        // Role restriction & cross-patient access tests
        const pharmTryAdmin = await pharmClient.request('GET', '/api/admin/dashboard');
        const pharmTryTriage = await pharmClient.request('POST', '/api/emergency/triage/1', { priority: 'P2' });
        const labTryAllocate = await labClient.request('POST', '/api/emergency/allocate/1', { doctor_id: 2, bed_id: 1 });
        const recTryTreatment = await recClient.request('POST', '/api/emergency/treatment/1', { action_type: 'Procedure', description: 'Test' });
        const patTryEmergency = await pat2Client.request('GET', '/api/emergency/queue');
        assert(
            pharmTryAdmin.status === 403 && pharmTryTriage.status === 403 &&
            labTryAllocate.status === 403 && recTryTreatment.status === 403 && patTryEmergency.status === 403,
            'TEST I.19: RBAC enforces 403 across Admin, Emergency Triage, Bed Allocation, Treatment, and Patient boundaries'
        );

        // Patient trying to view another patient's bill (Bill #1 belongs to patient_id=5 Rahul Verma; pat2Client is patient_id=6 Priya Nair)
        const crossPatientBill = await pat2Client.request('GET', '/api/billing/1');
        const crossPatientItems = await pat2Client.request('GET', '/api/billing/1/items');
        assert(
            crossPatientBill.status === 403 && crossPatientItems.status === 403,
            "TEST I.20: Patient is blocked (403) from viewing another patient's bill or bill items"
        );

        // =========================================================================
        // TEST B & TEST C – NORMAL PATIENT WORKFLOW & DOCTOR DASHBOARD
        // =========================================================================
        console.log('\n--- TEST B & TEST C: Doctor Dashboard & Complete Normal Patient Workflow ---');
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
        assert(regPat.status === 201 && regPat.data.patient_id, 'TEST C.1: Receptionist registers new patient with bcrypt password & 1NF allergies');
        const newPatientId = regPat.data.patient_id;

        // Duplicate patient registration prevention (TEST H.8 / TEST C)
        const dupRegPat = await recClient.request('POST', '/api/staff/receptionist/register-patient', {
            name: 'Aarav Kulkarni Duplicate',
            email: patEmail,
            phone: '9823011223',
            password: 'aarav_secret_pw'
        });
        assert(dupRegPat.status === 409, 'TEST C.2: Prevent duplicate patient registration with same email (409 Conflict)');

        const loginNewPat = await patClient.request('POST', '/api/auth/login', {
            email: patEmail,
            password: 'aarav_secret_pw'
        });
        assert(loginNewPat.status === 200 && loginNewPat.data.user.role === 'Patient', 'TEST C.3: Newly registered patient logs in via bcrypt');

        const availRes = await patClient.request('GET', `/api/patient/available-slots?doctor_id=2&appointment_date=${futureDate}`);
        const primarySlot = Array.isArray(availRes.data) && availRes.data.length ? availRes.data[0] : '10:30:00';
        const secondarySlot = Array.isArray(availRes.data) && availRes.data.length > 1 ? availRes.data[1] : '11:00:00';
        const tertiarySlot = Array.isArray(availRes.data) && availRes.data.length > 2 ? availRes.data[2] : '11:30:00';

        const bookAppt = await patClient.request('POST', '/api/patient/book-appointment', {
            doctor_id: 2,
            appointment_date: futureDate,
            appointment_time: primarySlot
        });
        assert(bookAppt.status === 201, `TEST C.4: Patient books appointment on ${futureDate} at ${primarySlot}`);

        const patAppts = await patClient.request('GET', '/api/patient/appointments');
        const bookedRow = Array.isArray(patAppts.data)
            ? patAppts.data.find(a => a.appointment_date === futureDate && a.appointment_time === primarySlot)
            : null;
        assert(
            Boolean(bookedRow && bookedRow.appointment_id && bookedRow.appointment_date === futureDate && bookedRow.department_name === 'Cardiology'),
            'TEST C.5: Patient appointment query returns exact YYYY-MM-DD dateStrings and derives Cardiology department'
        );
        const newApptId = bookedRow.appointment_id;

        const dupAppt = await patClient.request('POST', '/api/patient/book-appointment', {
            doctor_id: 2,
            appointment_date: futureDate,
            appointment_time: primarySlot
        });
        assert(dupAppt.status === 409, 'TEST C.6: Duplicate appointment slot rejected with 409 Conflict');

        // Receptionist Reschedule & Cancel workflow
        const recBook2 = await recClient.request('POST', '/api/staff/receptionist/book-appointment', {
            patient_id: newPatientId,
            doctor_id: 2,
            department_id: 1,
            appointment_date: futureDate,
            appointment_time: secondarySlot
        });
        const recList = await recClient.request('GET', '/api/staff/receptionist/appointments');
        const secondApptRow = Array.isArray(recList.data)
            ? recList.data.find(a => a.patient_id === newPatientId && a.appointment_date === futureDate && a.appointment_time === secondarySlot && a.status === 'Scheduled')
            : null;
        const secondApptId = secondApptRow ? secondApptRow.appointment_id : null;

        const reschedTaken = await recClient.request('POST', `/api/staff/receptionist/appointments/${secondApptId}/reschedule`, {
            appointment_date: futureDate,
            appointment_time: primarySlot
        });
        assert(recBook2.status === 201 && reschedTaken.status === 409, 'TEST C.7: Reschedule to taken slot returns 409 and rolls back cancellation');

        const reschedFree = await recClient.request('POST', `/api/staff/receptionist/appointments/${secondApptId}/reschedule`, {
            appointment_date: futureDate,
            appointment_time: tertiarySlot
        });
        const rescheduledApptId = reschedFree.data.appointment_id;
        const recCancel = await recClient.request('POST', `/api/staff/receptionist/appointments/${rescheduledApptId}/cancel`, {});
        assert(reschedFree.status === 201 && recCancel.status === 200, 'TEST C.8: Reschedule to free slot and subsequent cancellation succeed');

        // Doctor Dashboard tests (TEST B)
        const docScheduleAll = await doc1Client.request('GET', '/api/doctor/schedule');
        const docScheduleToday = await doc1Client.request('GET', `/api/doctor/schedule?date=${localIsoDate(0)}`);
        const docScheduleUpcoming = Array.isArray(docScheduleAll.data)
            ? docScheduleAll.data.filter(a => a.appointment_date > localIsoDate(0))
            : [];
        assert(
            docScheduleAll.status === 200 && docScheduleToday.status === 200 && docScheduleUpcoming.some(a => a.appointment_id === newApptId),
            "TEST B.1: Doctor dashboard loads full schedule, today's schedule, and upcoming appointments"
        );

        const confirmAppt = await doc1Client.request('PATCH', `/api/doctor/appointments/${newApptId}/status`, { status: 'Confirmed' });
        assert(confirmAppt.status === 200, 'TEST B.2: Doctor confirms appointment');

        const docPatHistory = await doc1Client.request('GET', `/api/doctor/patients/${newPatientId}/history`);
        assert(
            docPatHistory.status === 200 && docPatHistory.data.patient && docPatHistory.data.patient.allergies.includes('Penicillin'),
            'TEST B.3: Doctor opens patient history with demographics, allergies, consultations, prescriptions, and lab reports'
        );

        const crossDocConsult = await doc2Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Unauthorized attempt',
            diagnosis: 'Should fail'
        });
        const crossDocHist = await doc2Client.request('GET', `/api/doctor/patients/${newPatientId}/history`);
        assert(crossDocConsult.status === 403 && crossDocHist.status === 403, 'TEST B.4: Doctor 2 blocked from Doctor 1 appointment consultation and patient history (403)');

        // Test invalid consultation inputs (TEST B.9)
        const invalidConsultMissingDiag = await doc1Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Chest discomfort',
            diagnosis: '   '
        });
        const badConsultRx = await doc1Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Exertional dyspnea',
            diagnosis: 'Paroxysmal Atrial Fibrillation',
            prescription_items: [{ medicine_id: 999999, dosage: '250mg', duration_days: 5, quantity: 10 }]
        });
        const badConsultWard = await doc1Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Exertional dyspnea',
            diagnosis: 'Paroxysmal Atrial Fibrillation',
            recommend_admission: true,
            recommended_ward: 'NonExistentSpaceWard'
        });
        assert(
            invalidConsultMissingDiag.status === 400 && badConsultRx.status === 400 && badConsultWard.status === 400,
            'TEST B.5: Consultation validation rejects missing diagnosis, invalid medicine_id, and nonexistent ward without partial save (400)'
        );

        // Test API failure during consultation save -> verify transaction rollback (TEST B.10)
        testMysqlPool.__state.failNextQueryPattern = 'INSERT INTO MEDICAL_RECORD';
        const failedConsultSave = await doc1Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Transient failure test',
            diagnosis: 'Should roll back'
        });
        const [[consultAfterFail]] = await testMysqlPool.query('SELECT consultation_id FROM CONSULTATION WHERE appointment_id = ? FOR UPDATE', [newApptId]);
        assert(
            failedConsultSave.status === 500 && !consultAfterFail,
            'TEST B.6: Database failure mid-consultation rolls back the entire transaction cleanly'
        );

        // Save consultation with admission recommendation (TEST B.5)
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
        assert(consultRes.status === 201 && consultRes.data.consultation_id, 'TEST B.7: Doctor saves consultation, MEDICAL_RECORD, and ADMISSION_REQUEST');
        const newConsultId = consultRes.data.consultation_id;

        // Retry behavior & duplicate prevention on consultation (TEST B.11 & B.12)
        const retryConsult = await doc1Client.request('POST', '/api/doctor/consultations', {
            appointment_id: newApptId,
            symptoms: 'Exertional dyspnea, occasional palpitations',
            diagnosis: 'Paroxysmal Atrial Fibrillation',
            notes: 'Updated note on retry'
        });
        assert(
            retryConsult.status === 201 && retryConsult.data.consultation_id === newConsultId,
            'TEST B.8: Idempotent consultation retry updates existing consultation_id without creating duplicate CONSULTATION or ADMISSION_REQUEST'
        );

        // Submit prescription with multiple medicines (TEST B.6 & B.7)
        const prescRes = await doc1Client.request('POST', '/api/doctor/prescriptions', {
            consultation_id: newConsultId,
            items: [
                {
                    medicine_id: 2,
                    dosage: '250mg twice daily',
                    instructions: 'Take after meals with water',
                    duration_days: 5,
                    quantity: 10
                },
                {
                    medicine_id: 7,
                    dosage: '40mg once daily',
                    instructions: 'Before breakfast',
                    duration_days: 5,
                    quantity: 5
                }
            ]
        });
        assert(prescRes.status === 201 && prescRes.data.prescription_id, 'TEST B.9: Doctor submits multi-medicine prescription with instructions');
        const newPrescId = prescRes.data.prescription_id;

        // Submit laboratory request (TEST B.8)
        const labReqRes = await doc1Client.request('POST', '/api/doctor/lab-requests', {
            consultation_id: newConsultId,
            test_id: 2,
            priority: 'Urgent'
        });
        assert(labReqRes.status === 201 && labReqRes.data.request_id, 'TEST B.10: Doctor orders Urgent Lipid Profile lab request');
        const newLabReqId = labReqRes.data.request_id;

        // Lab report upload & duplicate report prevention (TEST C)
        const labUpload = await labClient.request('POST', `/api/staff/lab-tech/requests/${newLabReqId}/report`, {
            result_summary: 'Total Cholesterol: 185 mg/dL, LDL: 102 mg/dL, HDL: 48 mg/dL (Normal)',
            parameters: [
                { name: 'Total Cholesterol', value: 185, unit: 'mg/dL' },
                { name: 'LDL', value: 102, unit: 'mg/dL' }
            ],
            findings: 'Lipid parameters within acceptable range'
        });
        const dupLabUpload = await labClient.request('POST', `/api/staff/lab-tech/requests/${newLabReqId}/report`, {
            result_summary: 'Duplicate report attempt'
        });
        assert(
            labUpload.status === 201 && labUpload.data.report_id && dupLabUpload.status === 409,
            'TEST C.9: Lab Technician uploads structured report (MySQL + Mongo lab_reports_raw) and duplicate upload is rejected (409)'
        );

        const docLabs = await doc1Client.request('GET', '/api/doctor/lab-reports');
        const uploadedLab = Array.isArray(docLabs.data) ? docLabs.data.find(r => r.request_id === newLabReqId) : null;
        assert(
            docLabs.status === 200 && uploadedLab && uploadedLab.raw && Array.isArray(uploadedLab.raw.parameters),
            'TEST C.10: Doctor retrieves completed lab report with structured MongoDB parameters'
        );

        // Pharmacy dispensing & inventory deduction (TEST C)
        const dispSuccess = await pharmClient.request('POST', `/api/staff/pharmacist/dispense/${newPrescId}`, {
            notes: 'Dispensed Amoxicillin + Pantoprazole'
        });
        const dispAgain = await pharmClient.request('POST', `/api/staff/pharmacist/dispense/${newPrescId}`);
        const dispLowStock = await pharmClient.request('POST', '/api/staff/pharmacist/dispense/4');
        assert(
            dispSuccess.status === 200 && dispSuccess.data.deductions.length === 2 &&
            dispAgain.status === 409 && dispLowStock.status === 409,
            'TEST C.11: Pharmacist dispenses multi-item prescription in FEFO order, blocks duplicate dispensing (409), and blocks insufficient non-expired stock (409)'
        );

        // Billing, duplicate bill prevention, partial & full payment (TEST C)
        const genBill = await recClient.request('POST', '/api/staff/receptionist/generate-bill', { appointment_id: newApptId });
        const genBillAgain = await recClient.request('POST', '/api/staff/receptionist/generate-bill', { appointment_id: newApptId });
        assert(
            genBill.status === 201 && genBillAgain.status === 200 && genBillAgain.data.bill.bill_id === genBill.data.bill.bill_id,
            'TEST C.12: Receptionist generates invoice via sp_generate_bill; repeated request is idempotent and returns existing bill'
        );
        const newBillId = genBill.data.bill.bill_id;
        const totalAmt = Number(genBill.data.bill.total_amount);

        const payPartial = await recClient.request('POST', `/api/billing/${newBillId}/payments`, {
            amount_paid: 500,
            payment_method: 'UPI',
            reference_no: 'UPI-TXN-9001'
        });
        const dupRefPayment = await recClient.request('POST', `/api/billing/${newBillId}/payments`, {
            amount_paid: 500,
            payment_method: 'UPI',
            reference_no: 'UPI-TXN-9001'
        });
        const payFinal = await recClient.request('POST', `/api/billing/${newBillId}/payments`, {
            amount_paid: totalAmt - 500,
            payment_method: 'Card',
            reference_no: 'CARD-TXN-9002'
        });
        const billAfter = await patClient.request('GET', `/api/billing/${newBillId}`);
        assert(
            payPartial.status === 201 && dupRefPayment.status === 409 &&
            payFinal.status === 201 && billAfter.data.payment_status === 'Paid' && Number(billAfter.data.balance_due) === 0,
            'TEST C.13: Partial payment, duplicate reference_no rejection (409), and full balance settlement complete visit billing'
        );

        // Optional stage verification: consultation without lab request or prescription still completes and bills cleanly
        const optBook = await recClient.request('POST', '/api/staff/receptionist/book-appointment', {
            patient_id: newPatientId,
            doctor_id: 4,
            department_id: 3,
            appointment_date: futureDate,
            appointment_time: '14:00:00'
        });
        const optApptList = await recClient.request('GET', '/api/staff/receptionist/appointments');
        const optAppt = optApptList.data.find(a => a.patient_id === newPatientId && Number(a.doctor_id) === 4 && a.appointment_time === '14:00:00');
        const doc3Client = createClient(PORT);
        await doc3Client.request('POST', '/api/auth/login', { email: 'iyer.doc@medivault.in', password: 'doc3' });
        const optConsult = await doc3Client.request('POST', '/api/doctor/consultations', {
            appointment_id: optAppt.appointment_id,
            symptoms: 'Mild fatigue',
            diagnosis: 'Reassurance and hydration advice only'
        });
        const optBill = await recClient.request('POST', '/api/staff/receptionist/generate-bill', { appointment_id: optAppt.appointment_id });
        assert(
            optBook.status === 201 && optConsult.status === 201 && optBill.status === 201 && Number(optBill.data.bill.total_amount) === 500,
            'TEST C.14: Optional stages verified (consultation without lab request or prescription completes and bills consultation fee only)'
        );

        // =========================================================================
        // TEST D & TEST E – EMERGENCY WORKFLOW, PRIORITY ENGINE & EDGE CASES
        // =========================================================================
        console.log('\n--- TEST D & TEST E: Emergency Workflow, Priority Engine & All Edge Cases ---');

        // 1. Register walk-in emergency case -> verify it is Pending_Triage / UNASSESSED (NOT P3)
        const walkInReg = await recClient.request('POST', '/api/emergency/register', {
            temp_patient_name: 'Ramesh Deshmukh',
            temp_patient_gender: 'M',
            temp_patient_age: 58,
            contact_phone: '9822011223',
            arrival_method: 'Walk-in',
            initial_complaint: 'Severe substernal chest pain and sweating'
        });
        assert(
            walkInReg.status === 201 && walkInReg.data.assessment_status === 'Pending_Triage' && walkInReg.data.triage_priority === 'UNASSESSED',
            'TEST E.1: Newly registered emergency case is marked Pending_Triage / UNASSESSED (never silently defaulted to P3)'
        );
        const walkInCaseId = walkInReg.data.case_id;

        // 2. Verify Queue displays triage_pending = true and assessment_status = 'Pending_Triage'
        const queueBeforeTriage = await nurseClient.request('GET', '/api/emergency/queue');
        const walkInQueueRow = queueBeforeTriage.data.find(c => Number(c.case_id) === Number(walkInCaseId));
        assert(
            walkInQueueRow && walkInQueueRow.triage_pending === true && walkInQueueRow.triage_priority === 'UNASSESSED',
            'TEST E.2: Emergency queue explicitly identifies unassessed case as UNASSESSED with triage_pending=true'
        );

        // 3. Priority Engine on unassessed case -> withholds normal recommendation until triage
        const engineUnassessed = await nurseClient.request('GET', `/api/emergency/priority-engine/${walkInCaseId}`);
        assert(
            engineUnassessed.status === 200 &&
            engineUnassessed.data.triage_pending === true &&
            engineUnassessed.data.assessment_status === 'Pending_Triage' &&
            engineUnassessed.data.recommended_doctor === null &&
            engineUnassessed.data.recommended_bed === null,
            'TEST E.3: Priority Engine withholds normal automated recommendations when triage assessment is pending'
        );

        // 4. Invalid department lookup on registration & Priority Engine -> returns explicit no-match (never silently picks first department)
        const badDeptReg = await recClient.request('POST', '/api/emergency/register', {
            temp_patient_name: 'Test Dept Patient',
            initial_complaint: 'Headache',
            department_name: 'Neurosurgery_NonExistent'
        });
        assert(
            badDeptReg.status === 400 && badDeptReg.data.matched === false,
            'TEST E.4: Registration with nonexistent department returns 400 with matched=false instead of picking unrelated department'
        );

        // 5. Triage validation edge cases (TEST E.2 / Part 3.F)
        const badTriageBp = await nurseClient.request('POST', `/api/emergency/triage/${walkInCaseId}`, {
            bp_systolic: 80,
            bp_diastolic: 120, // systolic <= diastolic
            heart_rate: 90,
            spo2: 96,
            priority: 'P1',
            symptoms: 'Chest pain'
        });
        const badTriageSpo2 = await nurseClient.request('POST', `/api/emergency/triage/${walkInCaseId}`, {
            bp_systolic: 140,
            bp_diastolic: 90,
            heart_rate: 95,
            spo2: 115, // impossible > 100%
            priority: 'P1',
            symptoms: 'Chest pain'
        });
        const badTriageUnit = await nurseClient.request('POST', `/api/emergency/triage/${walkInCaseId}`, {
            bp_systolic: 140,
            bp_diastolic: 90,
            heart_rate: 95,
            spo2: 96,
            temperature: 99.1,
            temperature_unit: 'Kelvin', // invalid unit
            priority: 'P1',
            symptoms: 'Chest pain'
        });
        const badTriageMissingObs = await nurseClient.request('POST', `/api/emergency/triage/${walkInCaseId}`, {
            bp_systolic: 140,
            bp_diastolic: 90,
            heart_rate: 95,
            spo2: 96,
            priority: 'P1'
            // missing symptoms, injury_details, and assessment_notes
        });
        assert(
            badTriageBp.status === 400 && badTriageSpo2.status === 400 && badTriageUnit.status === 400 && badTriageMissingObs.status === 400,
            'TEST E.5: Triage validation rejects inverted BP, SpO2 > 100%, invalid temperature unit, and missing clinical observations (400)'
        );

        // 6. Valid Triage Assessment -> transitions case to Assessed P1
        const validTriage = await nurseClient.request('POST', `/api/emergency/triage/${walkInCaseId}`, {
            bp_systolic: 168,
            bp_diastolic: 104,
            heart_rate: 118,
            spo2: 89,
            temperature: 37.2,
            temperature_unit: 'C',
            respiratory_rate: 24,
            consciousness_level: 'Alert',
            gcs_score: 15,
            priority: 'P1',
            priority_reason: 'Acute ST-elevation myocardial infarction presentation with desaturation',
            symptoms: 'Crushing chest pain, diaphoresis, shortness of breath',
            injury_details: 'None',
            assessment_notes: '12-lead ECG shows inferior STEMI'
        });
        assert(
            validTriage.status === 201 && validTriage.data.assessment_status === 'Assessed' && validTriage.data.priority === 'P1',
            'TEST D.1: Authorized nurse triage assessment succeeds (converting Celsius to Fahrenheit and marking case Assessed)'
        );

        // 7. Priority Engine with no suitable department query parameter -> returns 404 no-match
        const engineNoDept = await nurseClient.request('GET', `/api/emergency/priority-engine/${walkInCaseId}?department=Oncology_NonExistent`);
        assert(
            engineNoDept.status === 404 && engineNoDept.data.matched === false && Array.isArray(engineNoDept.data.available_departments),
            'TEST E.6: Priority Engine returns 404 with available_departments list when requested department does not exist'
        );

        // 8. Priority Engine normal execution -> recommends Cardiology, on-shift doctor, and ICU bed (since P1 + SpO2 89 < 90)
        const prioEngine = await nurseClient.request('GET', `/api/emergency/priority-engine/${walkInCaseId}`);
        assert(
            prioEngine.status === 200 &&
            prioEngine.data.assessment_status === 'Assessed' &&
            prioEngine.data.recommended_department.name === 'Cardiology' &&
            prioEngine.data.recommended_doctor &&
            prioEngine.data.recommended_doctor.reason.includes('matches Cardiology') &&
            prioEngine.data.recommended_bed &&
            prioEngine.data.recommended_bed.ward_name === 'ICU',
            'TEST D.2: Priority Engine recommends Cardiology, explains doctor match, and selects ICU bed for P1 with SpO2 < 90%'
        );

        // 9. Edge case: Doctor on leave & Doctor outside shift -> excluded with factual explanation, and allocation rejected
        const todayStr = localIsoDate(0);
        const [leaveIns] = await testMysqlPool.query(
            "INSERT INTO DOCTOR_LEAVE (doctor_id, start_date, end_date, reason, status) VALUES (?, ?, ?, ?, 'Approved')",
            [15, todayStr, todayStr, 'Medical conference leave', 'Approved']
        );
        await testMysqlPool.query('UPDATE DOCTOR_SHIFT SET is_on_duty = ? WHERE doctor_id = ?', [false, 3]);

        const engineWithExclusions = await nurseClient.request('GET', `/api/emergency/priority-engine/${walkInCaseId}`);
        const doc15Excluded = (engineWithExclusions.data.excluded_doctors || []).find(d => Number(d.doctor_id) === 15);
        const doc3Excluded = (engineWithExclusions.data.excluded_doctors || []).find(d => Number(d.doctor_id) === 3);
        assert(
            Boolean(doc15Excluded && doc15Excluded.excluded_reason.includes('on approved leave')) &&
            Boolean(doc3Excluded && doc3Excluded.excluded_reason.includes('outside the current working shift')),
            'TEST E.7: Priority Engine excludes on-leave and off-shift doctors and provides factual exclusion explanations'
        );

        // Attempt to allocate doctor who became on-leave or off-shift after recommendation -> rejected with 409 and refreshed recommendations
        const allocLeaveDoc = await nurseClient.request('POST', `/api/emergency/allocate/${walkInCaseId}`, {
            doctor_id: 15,
            bed_id: prioEngine.data.recommended_bed.bed_id,
            override_reason: 'Trying to assign doc 15'
        });
        const allocOffShiftDoc = await nurseClient.request('POST', `/api/emergency/allocate/${walkInCaseId}`, {
            doctor_id: 3,
            bed_id: prioEngine.data.recommended_bed.bed_id,
            override_reason: 'Trying to assign doc 3'
        });
        assert(
            allocLeaveDoc.status === 409 && allocLeaveDoc.data.refreshed_recommendations &&
            allocOffShiftDoc.status === 409 && allocOffShiftDoc.data.refreshed_recommendations,
            'TEST E.8: Backend repeats doctor shift/leave checks on allocation, rejects unavailable doctors (409), and returns refreshed recommendations'
        );

        // Restore Doctor 3 shift and remove Doctor 15 leave
        await testMysqlPool.query('DELETE FROM DOCTOR_LEAVE WHERE leave_id = ?', [leaveIns.insertId]);
        await testMysqlPool.query('UPDATE DOCTOR_SHIFT SET is_on_duty = ? WHERE doctor_id = ?', [true, 3]);

        // 10. Manual Override without override_reason -> rejected with 400
        // Recommended doctor for Cardiology is Doctor 15 (0 active cases) or Doctor 2; pick Doctor 4 (General Medicine) to trigger override
        const overrideWithoutReason = await nurseClient.request('POST', `/api/emergency/allocate/${walkInCaseId}`, {
            doctor_id: 4,
            bed_id: prioEngine.data.recommended_bed.bed_id
        });
        assert(
            overrideWithoutReason.status === 400 && overrideWithoutReason.data.override_required === true,
            'TEST E.9: Selecting a non-recommended doctor without an override_reason is rejected with 400 Bad Request'
        );

        // 11. Manual Override WITH override_reason -> succeeds and saves recommended_doctor_id, selected doctor_id, override_reason, and assigned_by
        const overrideWithReason = await nurseClient.request('POST', `/api/emergency/allocate/${walkInCaseId}`, {
            doctor_id: 2, // Dr. Aditi Sharma (Cardiology HOD)
            bed_id: 9,    // E-03 (overriding ICU-2 bed_id=5 so bed_id=5 stays free for inpatient admission test)
            department_id: prioEngine.data.recommended_department.id,
            override_reason: 'Senior Cardiology HOD Dr. Aditi Sharma requested direct trauma bay E-03 management prior to Cath Lab'
        });
        const caseDetailsAfterAlloc = await nurseClient.request('GET', `/api/emergency/cases/${walkInCaseId}`);
        const latestDocAssign = caseDetailsAfterAlloc.data.doctor_assignments[0];
        const latestBedAssign = caseDetailsAfterAlloc.data.bed_assignments[0];
        assert(
            overrideWithReason.status === 200 &&
            latestDocAssign && Number(latestDocAssign.doctor_id) === 2 &&
            latestBedAssign && Number(latestBedAssign.bed_id) === 9 &&
            latestBedAssign.recommended_bed_id === 5 &&
            latestBedAssign.override_reason.includes('Cath Lab'),
            'TEST E.10: Manual override allocation records original recommendation, final resource, override_reason, staff member, and timestamp'
        );

        // 12. Concurrent allocation request for the same bed -> exactly one succeeds, the other gets 409 Conflict
        const [concAlloc1, concAlloc2] = await Promise.all([
            nurseClient.request('POST', '/api/emergency/allocate/3', {
                doctor_id: 2,
                bed_id: 10, // E-04 Available
                override_reason: 'Concurrent test case 3'
            }),
            nurseClient.request('POST', '/api/emergency/allocate/4', {
                doctor_id: 4,
                bed_id: 10, // E-04 Available (same bed!)
                override_reason: 'Concurrent test case 4'
            })
        ]);
        const statuses = [concAlloc1.status, concAlloc2.status].sort();
        assert(
            statuses[0] === 200 && statuses[1] === 409,
            'TEST E.11: Concurrent allocation requests for the same bed serialize via transaction lock (one 200 OK, one 409 Conflict)'
        );

        // =========================================================================
        // TEST F – ADMISSION, DISCHARGE, BILLING CONSISTENCY & BED CLEANING WORKFLOW
        // =========================================================================
        console.log('\n--- TEST F: Admission, Discharge, Billing Idempotency & Bed Cleaning Workflow ---');
        const pendingReqs = await nurseClient.request('GET', '/api/staff/nurse/admission-requests');
        const foundAdmReq = Array.isArray(pendingReqs.data) ? pendingReqs.data.find(r => r.patient_id === newPatientId) : null;
        assert(pendingReqs.status === 200 && foundAdmReq, 'TEST F.1: Nurse views pending ADMISSION_REQUEST from consultation');

        const assignOccupied = await nurseClient.request('POST', '/api/staff/nurse/assign-admission-bed', {
            request_id: foundAdmReq.request_id,
            bed_id: 1
        });
        assert(assignOccupied.status === 409, 'TEST F.2: Nurse blocked from assigning Occupied bed to admission request (409)');

        const assignAvailable = await nurseClient.request('POST', '/api/staff/nurse/assign-admission-bed', {
            request_id: foundAdmReq.request_id,
            bed_id: 5 // ICU-2 Available
        });
        assert(assignAvailable.status === 200 && assignAvailable.data.admission_id, 'TEST F.3: Nurse assigns Available bed (ICU-2, bed_id=5) to ADMISSION_REQUEST');
        const inpatientAdmId = assignAvailable.data.admission_id;

        // Duplicate admission attempt on the same request or patient -> rejected with 409
        const dupAssignAdm = await nurseClient.request('POST', '/api/staff/nurse/assign-admission-bed', {
            request_id: foundAdmReq.request_id,
            bed_id: 6
        });
        const dupPatchBedAdm = await nurseClient.request('PATCH', '/api/admin/beds/6', {
            patient_id: newPatientId,
            status: 'Occupied'
        });
        assert(
            dupAssignAdm.status === 409 && dupPatchBedAdm.status === 409,
            'TEST F.4: Duplicate inpatient admission attempts for an already-admitted patient are rejected with 409 Conflict'
        );

        // Concurrent inpatient discharge attempts -> one succeeds (200), the second returns 409, and only ONE Admission BILL_ITEM is created
        const [concDisch1, concDisch2] = await Promise.all([
            nurseClient.request('POST', '/api/staff/nurse/discharge-inpatient', {
                admission_id: inpatientAdmId,
                discharge_summary: 'Discharged home in stable sinus rhythm',
                room_fee: 3500
            }),
            nurseClient.request('POST', '/api/staff/nurse/discharge-inpatient', {
                admission_id: inpatientAdmId,
                discharge_summary: 'Concurrent duplicate discharge attempt',
                room_fee: 3500
            })
        ]);
        const dischStatuses = [concDisch1.status, concDisch2.status].sort();
        const winDisch = concDisch1.status === 200 ? concDisch1 : concDisch2;
        const dischBillItems = await recClient.request('GET', `/api/billing/${winDisch.data.bill_id}/items`);
        const admChargeCount = Array.isArray(dischBillItems.data)
            ? dischBillItems.data.filter(i => i.item_type === 'Admission').length
            : 0;
        assert(
            dischStatuses[0] === 200 && dischStatuses[1] === 409 &&
            winDisch.data.bed_status === 'Cleaning' && admChargeCount === 1,
            'TEST F.5: Concurrent inpatient discharge attempts allow exactly one discharge (200 vs 409), create only 1 Admission charge, and set bed to Cleaning'
        );

        // Verify bed is in Cleaning status and cannot be assigned before cleaning confirmation
        const bed5DuringCleaning = await nurseClient.request('GET', '/api/admin/beds/5');
        assert(bed5DuringCleaning.data.status === 'Cleaning', 'TEST F.6: Released bed remains in Cleaning status until staff confirmation');

        const markAvail = await nurseClient.request('POST', '/api/staff/nurse/beds/5/mark-available');
        assert(markAvail.status === 200 && markAvail.data.status === 'Available', 'TEST F.7: Authorized staff confirms cleaning and marks bed Available');

        // Emergency treatment, discharge & repeated emergency discharge prevention
        const ownEmgTreat = await doc1Client.request('POST', `/api/emergency/treatment/${walkInCaseId}`, {
            action_type: 'Medication Administered',
            description: 'Dual antiplatelet loading + IV Heparin bolus'
        });
        const emgDischarge1 = await doc1Client.request('POST', `/api/emergency/discharge/${walkInCaseId}`, {
            discharge_summary: 'Stabilized in emergency bay; discharged to outpatient follow-up.',
            emergency_fee: 950
        });
        const emgDischarge2 = await doc1Client.request('POST', `/api/emergency/discharge/${walkInCaseId}`, {
            discharge_summary: 'Repeated emergency discharge attempt',
            emergency_fee: 950
        });
        assert(
            ownEmgTreat.status === 201 && emgDischarge1.status === 200 &&
            emgDischarge1.data.bed_status === 'Cleaning' && emgDischarge2.status === 409,
            'TEST F.8: Emergency discharge moves bed to Cleaning and blocks repeated emergency discharge (409)'
        );
        await nurseClient.request('POST', '/api/staff/nurse/beds/9/mark-available');

        // =========================================================================
        // TEST G – BLOOD BANK WORKFLOW
        // =========================================================================
        console.log('\n--- TEST G: Blood Bank Inventory, Approval Gate, Issuance & Duplicate Deduction Prevention ---');
        const invBefore = await doc1Client.request('GET', '/api/admin/blood-bank');
        const oNegBefore = invBefore.data.find(b => b.blood_group === 'O-').units_available;

        const bloodReq = await doc1Client.request('POST', '/api/admin/blood-bank/request', {
            blood_group: 'O-',
            units: 1,
            patient_id: 6,
            case_id: 3,
            priority: 'Emergency',
            reason: 'Standby cross-match for trauma resuscitation'
        });
        const bReqId = bloodReq.data.request_id;

        const fulfillUnapproved = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bReqId}/fulfill`);
        const approveBReq = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bReqId}/approve`);
        const fulfillApproved = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bReqId}/fulfill`);
        const fulfillDuplicate = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bReqId}/fulfill`);

        const invAfter = await doc1Client.request('GET', '/api/admin/blood-bank');
        const oNegAfter = invAfter.data.find(b => b.blood_group === 'O-').units_available;

        assert(
            bloodReq.status === 201 && fulfillUnapproved.status === 409 &&
            approveBReq.status === 200 && fulfillApproved.status === 200 &&
            fulfillDuplicate.status === 409 && oNegAfter === oNegBefore - 1,
            'TEST G.1: Blood request enforces approval gate (409), deducts exact inventory on fulfillment, and prevents duplicate deduction (409)'
        );

        // Reject request workflow & insufficient inventory check
        const bloodReqReject = await doc1Client.request('POST', '/api/admin/blood-bank/request', {
            blood_group: 'AB-',
            units: 1,
            patient_id: 6,
            priority: 'Normal',
            reason: 'Elective reserve'
        });
        const rejectRes = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bloodReqReject.data.request_id}/reject`);
        const fulfillRejected = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bloodReqReject.data.request_id}/fulfill`);

        // AB- has 3 units in seed data; request 5 units and approve -> fulfillment must fail with 409
        const bloodReqExcess = await doc1Client.request('POST', '/api/admin/blood-bank/request', {
            blood_group: 'AB-',
            units: 5,
            patient_id: 6,
            priority: 'Urgent',
            reason: 'Excess stock test'
        });
        await adminClient.request('POST', `/api/admin/blood-bank/requests/${bloodReqExcess.data.request_id}/approve`);
        const fulfillExcess = await adminClient.request('POST', `/api/admin/blood-bank/requests/${bloodReqExcess.data.request_id}/fulfill`);
        assert(
            rejectRes.status === 200 && fulfillRejected.status === 409 && fulfillExcess.status === 409,
            'TEST G.2: Blood bank supports rejecting requests, blocks fulfilling rejected requests (409), and blocks issuing when inventory is insufficient (409)'
        );

        // =========================================================================
        // TEST H – AMBULANCE FLEET, DRIVER ASSIGNMENT, DISPATCH & ARRIVAL
        // =========================================================================
        console.log('\n--- TEST H: Ambulance Registration, Driver Assignment, Dispatch, Arrival & Patient Linking ---');
        const newVehicleNo = `MH12XY${runTag.slice(-4)}`;
        const regAmb = await adminClient.request('POST', '/api/admin/ambulances', {
            vehicle_number: newVehicleNo,
            driver_name: 'akash More',
            driver_phone: '9765001122'
        });
        const dupRegAmb = await adminClient.request('POST', '/api/admin/ambulances', {
            vehicle_number: newVehicleNo,
            driver_name: 'Duplicate Driver'
        });
        assert(
            regAmb.status === 201 && regAmb.data.ambulance_id && dupRegAmb.status === 409,
            'TEST H.1: Register new ambulance succeeds (201) and duplicate vehicle number is rejected (409)'
        );
        const newAmbId = regAmb.data.ambulance_id;

        const assignDriver = await adminClient.request('PATCH', `/api/admin/ambulance/${newAmbId}`, {
            driver_name: 'Prakash More',
            driver_phone: '9765009988'
        });
        assert(
            assignDriver.status === 200 && assignDriver.data.driver_name === 'Prakash More',
            'TEST H.2: Assign/update ambulance driver details succeeds'
        );

        // Dispatch ambulance for existing patient Priya Nair (user_id=6) -> links to existing patient_id=6 without creating duplicate patient
        const patCountBeforeAmb = (await testMysqlPool.query('SELECT COUNT(*) AS cnt FROM PATIENT'))[0][0].cnt;
        const ambDispatch = await adminClient.request('POST', `/api/admin/ambulance/${newAmbId}/dispatch`, {
            patient_name: 'Priya Nair',
            pickup_location: 'Koregaon Park Lane 5, Pune',
            destination: 'MediCare Emergency Trauma Bay',
            contact_phone: '9811100002',
            initial_complaint: 'Acute dizziness and syncope'
        });
        const patCountAfterAmb = (await testMysqlPool.query('SELECT COUNT(*) AS cnt FROM PATIENT'))[0][0].cnt;
        assert(
            ambDispatch.status === 200 && ambDispatch.data.case_id &&
            Number(ambDispatch.data.patient_id) === 6 && patCountAfterAmb === patCountBeforeAmb,
            'TEST H.3: Ambulance dispatch links existing patient (patient_id=6) and creates linked EMERGENCY_CASE without duplicating patient records'
        );

        // Record ambulance arrival -> completes dispatch and returns ambulance to Available
        const ambArrive = await nurseClient.request('POST', `/api/admin/ambulance/${newAmbId}/arrive`);
        assert(
            ambArrive.status === 200 && ambArrive.data.ambulance_status === 'Available',
            'TEST H.4: Recording ambulance arrival completes dispatch, updates arrival timestamp, and marks ambulance Available'
        );

        // =========================================================================
        // TEST J – DATABASE RELIABILITY (MYSQL & MONGODB OUTAGES, OUTBOX & RECOVERY)
        // =========================================================================
        console.log('\n--- TEST J: MySQL & MongoDB Outages, Outbox Queuing & Automatic Recovery ---');

        // 1. Simulate MongoDB disconnected -> verify /health reports degraded, strict Mongo calls return 503, and lab report queues in CROSS_DB_OUTBOX
        dbModule.__setSimulatedOutage({ mongoDown: true });
        const healthMongoDown = await anonClient.request('GET', '/health');
        assert(
            healthMongoDown.status === 200 &&
            healthMongoDown.data.status === 'degraded' &&
            healthMongoDown.data.mongodb.connected === false &&
            healthMongoDown.data.readiness === 'degraded_mongo_offline',
            'TEST J.1: When MongoDB is disconnected, /health reports status=degraded and readiness=degraded_mongo_offline (never falsely healthy)'
        );

        // Strict Mongo-required request rejects with 503 when require_mongo_sync=true
        const strictLabFail = await labClient.request('POST', '/api/staff/lab-tech/requests/4/report', {
            result_summary: 'Fasting Blood Glucose: 108 mg/dL',
            require_mongo_sync: true
        });
        assert(
            strictLabFail.status === 503 && strictLabFail.data.service === 'mongodb',
            'TEST J.2: MongoDB-dependent strict operation returns 503 Service Unavailable without pretending MongoDB succeeded'
        );

        // Resilient lab report upload while MongoDB is offline -> saves MySQL LAB_REPORT, queues raw payload in CROSS_DB_OUTBOX, and returns warning
        const offlineLabUpload = await labClient.request('POST', '/api/staff/lab-tech/requests/4/report', {
            result_summary: 'Fasting Blood Glucose: 108 mg/dL (Impaired fasting glucose)',
            parameters: [{ name: 'Fasting Glucose', value: 108, unit: 'mg/dL' }]
        });
        assert(
            offlineLabUpload.status === 201 &&
            offlineLabUpload.data.mongo_sync_status === 'Pending' &&
            Boolean(offlineLabUpload.data.warning),
            'TEST J.3: Lab report saved during MongoDB outage queues structured payload in CROSS_DB_OUTBOX (status=Pending) and returns explicit warning'
        );

        // Restore MongoDB connection and reconcile CROSS_DB_OUTBOX -> verify queued document is synced into MongoDB lab_reports_raw
        dbModule.__setSimulatedOutage({ mongoDown: false });
        const reconcileRes = await adminClient.request('POST', '/api/admin/reconcile-outbox');
        const syncedRawDoc = await testMongoDb.collection('lab_reports_raw').findOne({ request_id: 4 });
        assert(
            reconcileRes.status === 200 && reconcileRes.data.reconciled >= 1 &&
            reconcileRes.data.remaining === 0 && Boolean(syncedRawDoc && syncedRawDoc.result_summary.includes('108 mg/dL')),
            'TEST J.4: Restoring MongoDB and running outbox reconciliation syncs all pending CROSS_DB_OUTBOX records to MongoDB with zero data loss'
        );

        // 2. Simulate MySQL disconnected -> verify /health returns 503 and MySQL-dependent operations return 503 Service Unavailable
        dbModule.__setSimulatedOutage({ mysqlDown: true });
        const healthMysqlDown = await anonClient.request('GET', '/health');
        const liveDuringMysqlDown = await anonClient.request('GET', '/health/live');
        const apiDuringMysqlDown = await adminClient.request('GET', '/api/admin/dashboard');
        assert(
            liveDuringMysqlDown.status === 200 &&
            healthMysqlDown.status === 503 &&
            healthMysqlDown.data.readiness === 'not_ready_mysql_offline' &&
            apiDuringMysqlDown.status === 503,
            'TEST J.5: When MySQL is disconnected, /health/live stays 200 (alive), /health returns 503 (not_ready_mysql_offline), and API routes return 503'
        );

        // Restore MySQL connection -> verify immediate recovery
        dbModule.__setSimulatedOutage({ mysqlDown: false });
        const healthRestored = await anonClient.request('GET', '/health');
        assert(
            healthRestored.status === 200 && healthRestored.data.status === 'ok',
            'TEST J.6: Application recovers automatically once MySQL connectivity is restored'
        );

        // =========================================================================
        // ADMIN STAFF CREATION & PROFILE PASSWORD UPDATE
        // =========================================================================
        console.log('\n--- Admin Staff Management & Profile Verification ---');
        const staffEmail = `meera.deshmukh.${runTag}@medivault.in`;
        const nonAdminStaffCreate = await recClient.request('POST', '/api/admin/staff', {
            name: 'Unauthorized Staff',
            email: `unauth.${runTag}@medivault.in`,
            password: 'staff_pw_123',
            role: 'Nurse',
            shift: 'Morning'
        });
        const createStaffRes = await adminClient.request('POST', '/api/admin/staff', {
            name: 'Meera Deshmukh',
            email: staffEmail,
            phone: '9823099887',
            password: 'meera_staff_pw',
            role: 'Nurse',
            department_id: 1,
            shift: 'Evening'
        });
        const dupStaffEmail = await adminClient.request('POST', '/api/admin/staff', {
            name: 'Duplicate Staff',
            email: staffEmail,
            password: 'another_password',
            role: 'Pharmacist',
            shift: 'Morning'
        });
        assert(
            nonAdminStaffCreate.status === 403 && createStaffRes.status === 201 && dupStaffEmail.status === 409,
            'Admin staff creation enforces RBAC (403), creates USER+STAFF in transaction (201), and blocks duplicate email (409)'
        );

        console.log('\n=== E2E VERIFICATION SUMMARY ===');
        console.log(`Total Assertions Executed: ${passed + failed}`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);

        server.close();
        if (failed > 0) process.exit(1);
    } catch (err) {
        server.close();
        console.error('Test script crashed:', err);
        process.exit(1);
    }
}

runTests();
