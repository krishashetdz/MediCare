# MediVault Route Manifest

Generated 2026-09-17 after adding 4 new Admin routes for Screen 2 (Dashboard).

## Admin Routes (`/api/admin/*`)

All routes protected by `requireRole('Admin')` middleware.

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/dashboard` | `{total_patients, total_doctors, total_appointments, available_beds, pending_lab_reports, low_stock_medicines, monthly_revenue: [], bed_occupancy: []}` | Admin Dashboard (Screen 2) — stat cards + revenue/bed charts |
| GET | `/doctors` | `[{doctor_id, name, email, department_name, specialization, consultation_fee}]` | Admin doctor management |
| POST | `/doctors` | `{doctor_id}` | Admin doctor creation |
| PUT | `/doctors/:id` | `{message}` | Admin doctor edit |
| DELETE | `/doctors/:id` | `{message}` | Admin doctor deletion |
| GET | `/notifications` | `[{notification_id, message, is_read, created_at}]` | Admin Dashboard alert feed + topbar bell |
| PATCH | `/notifications/mark-all-read` | `{message}` | Topbar bell dropdown |
| **GET** | **`/emergencies/count`** | **`{count}`** | **Admin Dashboard emergency tile (Screen 2)** |
| **GET** | **`/ambulances/available`** | **`{count}`** | **Admin Dashboard ambulance tile (Screen 2)** |
| **GET** | **`/appointments/by-department`** | **`[{department_name, count}]`** | **Admin Dashboard bar chart (Screen 2)** |
| **GET** | **`/appointments?limit=N`** | **`[{appointment_id, patient_name, doctor_name, department_name, appointment_date, appointment_time, status}]`** | **Admin Dashboard recent appointments table (Screen 2)** |

**Bold** = newly added routes.

## Notes

- `/emergencies/count` queries `BED.status='Emergency'` but Phase 2 DDL CHECK constraint only allows `'Available'|'Occupied'` — returns 0 until schema modified. UI handles this gracefully (shows 0, not an error).
- `/appointments/by-department` LEFT JOINs DEPARTMENT so departments with 0 appointments still appear (count=0).
- `/appointments` defaults limit=10, accepts any integer. Orders by `created_at DESC` so newest appear first.
- All 4 routes follow existing error handling pattern: try/catch → 500 + `{error: '...'}` on failure.
- RBAC enforced at router level (`router.use(requireRole('Admin'))`) — no per-route auth needed.

## Views Leveraged

- `vw_monthly_revenue` — `/dashboard` monthly_revenue array
- `vw_bed_occupancy` — `/dashboard` bed_occupancy array + donut chart

## Bed Management Routes (Screen 3)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/patients?q=<query>` | `[{patient_id, name, email, phone, blood_group}]` | Bed assign drawer — patient search autocomplete |
| GET | `/beds?ward=<name>` | `[{bed_id, ward_name, bed_number, status, patient_name, patient_phone, patient_blood_group}]` | Bed Management ward grid |
| GET | `/beds/:id` | `{bed_id, ward_name, bed_number, status, patient_name, patient_phone, patient_blood_group}` | Bed detail drawer |
| PATCH | `/beds/:id` | `{message}` | Assign/release bed actions |

**Notes:**
- `/patients` search returns empty array if `q` < 2 chars. Searches `name` and `email` fields, limit 20.
- `/beds` with no `ward` param returns all beds across all wards.
- PATCH `/beds/:id` accepts `{patient_id, status}` — set `patient_id=null, status='Available'` to release.

## Pharmacy Routes (Screen 4)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/staff/pharmacist/pending-prescriptions` | `[{prescription_id, patient_name, doctor_name, prescribed_date}]` | Pharmacy pending queue |
| GET | `/staff/pharmacist/prescription-items/:prescriptionId` | `[{item_id, medicine_id, medicine_name, dosage, duration_days, quantity, current_stock}]` | Dispense modal item list |
| GET | `/staff/pharmacist/inventory?q=<search>` | `[{medicine_id, medicine_name, manufacturer, unit_price, stock_qty, expiry_date}]` | Inventory table with search |
| POST | `/staff/pharmacist/dispense/:prescriptionId` | `{message}` | Dispense action — triggers `trg_update_stock` |

**Notes:**
- POST `/dispense/:id` fires `trg_update_stock` (auto-decrements `MEDICINE.stock_qty` for all items), which chains into `trg_low_stock_alert` when crossing below 20.
- Returns 409 with `err.sqlMessage` if insufficient stock (SIGNAL from trigger).
- Frontend fetches items before+after dispense to show stock diff in success toast.

## Lab Routes (Screen 5)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/staff/lab-tech/pending-requests` | `[{request_id, test_name, patient_name, requested_by}]` | Lab pending queue |
| POST | `/staff/lab-tech/requests/:id/report` | `{message}` | Submit lab results — inserts LAB_REPORT + updates LAB_REQUEST.status |
| GET | `/staff/lab-tech/completed-reports` | `[{report_id, test_name, patient_name, report_date}]` | Completed reports list (limit 50, newest first) |
| GET | `/staff/lab-tech/reports/:reportId` | `{report_id, result_summary, report_date, test_name, patient_name, technician_name}` | View single report detail |

**Notes:**
- POST `/requests/:id/report` body: `{result_summary: string}`. Transaction inserts report + marks request completed.
- Print CSS included in `lab.html` — hides modal chrome, shows report body only.

## Billing Routes (Screen 6)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/billing/:billId` | `{bill_id, patient_id, appointment_id, total_amount, payment_status, bill_date, patient_name}` | Billing invoice view |
| GET | `/billing/:billId/items` | `[{bill_item_id, item_type, description, amount}]` | Invoice itemized table |

**Notes:**
- Role-based access: Patient sees only own bills, staff sees all.
- Print CSS included in `billing.html` — hides header/buttons, shows invoice body only.
- Insurance fields (`insurance_provider`, `insurance_policy_number`) placeholder — Phase 5 MongoDB stores full policy details.

## Blood Bank Routes (Screen 7)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/admin/blood-bank` | `[{blood_id, blood_group, units_available, last_updated}]` | Blood bank inventory cards |

**Notes:**
- 8 blood groups: A+, A-, B+, B-, AB+, AB-, O+, O-.
- Gauge thresholds: critical <10, low <30, good ≥30.
- Request form demo — Phase 5 tracks transfusion orders in MongoDB `transfusion_requests`.

## Ambulance Routes (Screen 8)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/admin/ambulances` | `[{ambulance_id, vehicle_number, driver_name, driver_phone, status}]` | Ambulance fleet cards |
| POST | `/admin/ambulance/:id/dispatch` | `{message}` | Dispatch ambulance — body: `{patient_name, pickup_location, destination, contact_phone}`. Updates status='On Duty'. Phase 5: logs to MongoDB `ambulance_dispatch_log`. |
| POST | `/admin/ambulance/:id/release` | `{message}` | Mark ambulance available — updates status='Available'. |

**Notes:**
- Status values: 'Available', 'On Duty'.
- Dispatch modal collects patient/location details.

## Doctor Dashboard Routes (Screen 9)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/doctor/schedule` | `[{appointment_id, doctor_id, doctor_name, patient_name, appointment_time, status}]` | Today's schedule timeline (from `vw_doctor_today_schedule`) |
| GET | `/doctor/patients/:patientId/history` | `{records: [{...}], consultations: [{consultation_id, symptoms, diagnosis, consultation_date, ...}]}` | Patient profile medical history |
| POST | `/doctor/consultations` | `{consultation_id}` | Submit consultation — body: `{appointment_id, symptoms, diagnosis, notes}`. Updates appointment status='Completed'. |
| POST | `/doctor/prescriptions` | `{prescription_id}` | Submit prescription — body: `{consultation_id, patient_id, items: [{medicine_id, dosage, duration_days, quantity}]}`. Transaction: header + items. |
| POST | `/doctor/lab-requests` | `{request_id}` | Request lab test — body: `{consultation_id, test_id, priority}`. Priority: Normal/Urgent/Emergency. |
| GET | `/doctor/medicines/search?q=<query>` | `[{medicine_id, medicine_name, stock_qty}]` | Medicine autocomplete (LIKE search, stock > 0, limit 20) |
| GET | `/doctor/lab-tests` | `[{test_id, test_name}]` | Lab test list for request modal |

**Notes:**
- Schedule view uses `vw_doctor_today_schedule` (filtered to logged-in doctor).
- Prescription builder: searchable autocomplete with datalist, add/remove rows.
- Lab request modal: test dropdown + priority select.
- Timeline shows time + patient + status badge, click opens consultation modal.

## Patient Portal Routes (Screen 10)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/patient/summary` | `{patient_id, patient_name, next_appointment_date, record_count, pending_bills, unread_notifications}` | Portal home hero + stats cards (from `vw_patient_portal_summary`) |
| POST | `/patient/book-appointment` | `{message}` | Booking wizard final step — body: `{doctor_id, department_id, appointment_date, appointment_time}`. Calls `sp_book_appointment` (transactional slot check + insert). Returns 409 on conflict. |
| GET | `/patient/departments` | `[{department_id, department_name}]` | Booking wizard step 1 |
| GET | `/patient/doctors?department_id=<id>` | `[{doctor_id, doctor_name, specialization}]` | Booking wizard step 2 |
| GET | `/patient/available-slots?doctor_id=<id>&appointment_date=<date>` | `["09:00:00", "09:30:00", ...]` | Booking wizard step 4. Returns 30-min slots 9:00-17:00, filters out already-booked times. |
| GET | `/patient/records` | `[{record_id, diagnosis, treatment, created_at, ...}]` | Medical history timeline |
| GET | `/patient/lab-reports` | `[{report_id, request_id, test_name, result_summary, report_date, raw: {...}}]` | Lab reports table. `raw` from MongoDB `lab_reports_raw` (Phase 5), null if unavailable. |
| GET | `/patient/prescriptions` | `[{prescription_id, prescription_date, status, doctor_name}]` | Prescriptions list |
| GET | `/patient/prescriptions/:id/items` | `[{medicine_name, dosage, duration_days, quantity}]` | Prescription detail modal |
| GET | `/patient/bills` | `[{bill_id, total_amount, payment_status, bill_date, ...}]` | Bills table |
| GET | `/patient/notifications` | `[{notification_id, message, is_read, created_at}]` | Notification dropdown |
| PATCH | `/patient/notifications/:id/read` | `{message}` | Mark notification read |

**Notes:**
- Portal home: welcome hero + next appointment card + 3 stat cards (records, pending bills, notifications).
- Booking wizard: 4 steps with progress indicator — Department grid → Doctor cards → Calendar (14 days ahead) → Time slots.
- `sp_book_appointment` ensures no double-booking (transactional).
- Lab reports degrade gracefully if MongoDB unavailable (returns MySQL summary only).

## Staff Portal Routes (Screen 11)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| GET | `/staff/nurse/beds` | `[{bed_id, ward_name, bed_number, status, patient_name, patient_phone, patient_blood_group}]` | Nurse ward board (uses `vw_bed_occupancy`) |
| GET | `/staff/nurse/ward/:wardName/patients` | `[{patient_id, patient_name, bed_number}]` | Nurse patient list per ward |
| GET | `/staff/lab-tech/pending-requests` | `[{request_id, test_name, patient_name, requested_by}]` | Lab tech queue |
| POST | `/staff/lab-tech/requests/:id/report` | `{message}` | Lab result submission — body: `{result_summary}`. Inserts LAB_REPORT + marks request completed. |
| GET | `/staff/lab-tech/completed-reports` | `[{report_id, test_name, patient_name, report_date}]` | Lab completed reports table |
| GET | `/staff/lab-tech/reports/:reportId` | `{report_id, result_summary, report_date, test_name, patient_name, technician_name}` | Lab report detail |
| GET | `/staff/pharmacist/pending-prescriptions` | `[{prescription_id, patient_name, doctor_name, prescribed_date}]` | Pharmacist prescription queue |
| GET | `/staff/pharmacist/prescription-items/:prescriptionId` | `[{item_id, medicine_id, medicine_name, dosage, duration_days, quantity, current_stock}]` | Dispense modal item preview |
| POST | `/staff/pharmacist/dispense/:prescriptionId` | `{message}` | Dispense action — triggers `trg_update_stock` (auto-decrements stock) + `trg_low_stock_alert` (if <20). Returns 409 on insufficient stock. |
| GET | `/staff/pharmacist/inventory?q=<search>` | `[{medicine_id, medicine_name, manufacturer, unit_price, stock_qty, expiry_date}]` | Pharmacist inventory table with search |
| GET | `/staff/pharmacist/notifications` | `[{notification_id, message, is_read, created_at}]` | Pharmacist low-stock alerts |
| POST | `/staff/receptionist/register-patient` | `{message}` | Patient registration — body: `{name, email, phone, dob, gender, blood_group, address, emergency_contact, password_hash}` |
| POST | `/staff/receptionist/book-appointment` | `{message}` | Quick booking — body: `{patient_id, doctor_id, department_id, appointment_date, appointment_time}` |
| POST | `/staff/receptionist/generate-bill` | `{bill_id}` | Generate bill (calls `sp_generate_bill`) — body: `{patient_id, appointment_id, total_amount}` |

**Notes:**
- Single unified `staff-portal.html` with role-aware tabs — shows only sections for logged-in role.
- Role tabs: Nurse → Ward Board | Lab Tech → Test Queue / Completed | Pharmacist → Prescription Queue / Inventory | Receptionist → Register / Quick Booking.
- All routes already implemented in `staff.js` — no new backend routes added.
- Nurse ward board uses `vw_bed_occupancy` view.
- Pharmacist dispense triggers `trg_update_stock` (stock decrement) + `trg_low_stock_alert` (notification when <20).
- Lab result entry: modal collects `result_summary`, inserts report + marks request completed.
- Receptionist quick booking bypasses wizard — direct form with IDs.

## Profile Route (Screen 12)

| Method | Path | Response | Consumed By |
|--------|------|----------|-------------|
| POST | `/profile/change-password` | `{message}` | Profile page password change form — body: `{current_password, new_password}`. Validates current password with bcrypt, hashes new password, updates USER table. |

**Notes:**
- Profile page shows user info based on role: Patient (phone, blood group, address, emergency contact), Doctor (department, specialization, consultation fee), other roles (email only).
- Avatar shows initials (first letter of each name word, max 2).
- 404 page standalone — no shell mount, just error card with "Go Back" + "Go Home" buttons.

## Mobile Responsiveness

**Breakpoints:**
- `991.98px`: Sidebar collapses to hamburger menu, drawer narrows to 380px
- `767.98px`: Booking wizard vertical, department/doctor/time grids adjust, blood bank 2-col, ambulance 1-col, staff tabs horizontal scroll, ward board shrinks
- `575.98px`: Sidebar 84vw, page padding 1rem, stats 1-col, blood bank 1-col, calendar 3-col, time slots 1-col, ward board tiles 60px

**Print styles:**
- Hides sidebar, topbar, toasts, backdrop, drawer, toolbar, pagination
- Shows `.mv-print-only` elements
- A4 page margins 14mm
- Used by billing invoice + lab report print views

## All Screens Complete

✅ Screen 1: Login
✅ Screen 2: Admin Dashboard
✅ Screen 3: Bed Management
✅ Screen 4: Pharmacy
✅ Screen 5: Lab
✅ Screen 6: Billing
✅ Screen 7: Blood Bank
✅ Screen 8: Ambulance
✅ Screen 9: Doctor Dashboard
✅ Screen 10: Patient Portal
✅ Screen 11: Staff Portal (Nurse/Lab Tech/Pharmacist/Receptionist)
✅ Screen 12: Profile + 404 + Mobile Responsive

**Database frozen:** No schema changes made — all routes use existing tables, views, stored procedures, triggers.
**Design system:** Teal #0D9488 primary, dark sidebar #0F172A, app bg #F8FAFC, Inter font, rounded-xl cards, pill badges consistent across all screens.
**Accessibility:** Labels, focus rings (--mv-focus), contrast ratios meet WCAG AA, keyboard navigation functional.
**Stack:** HTML/CSS/Bootstrap 5.3.3 + vanilla JS, Chart.js for graphs, Font Awesome 6.5.1 icons.
**API wiring:** All lists/cards fetch real data, no hardcoded fake data.

---

## Final Migration: Lucide → Font Awesome

All HTML pages migrated from `medivault.css` + Lucide to `medivault-restyle.css` + Font Awesome:

**Updated pages:**
- `login.html`, `admin-dashboard.html`, `bed-management.html`, `pharmacy.html`, `lab.html`
- `billing.html`, `blood-bank.html`, `ambulance.html`, `doctor-dashboard.html`
- `patient-portal.html`, `staff-portal.html`, `profile.html`, `404.html`

**Changes per page:**
1. Removed theme toggle script (handled by CSS tokens)
2. Replaced `<link href="/assets/css/medivault.css">` with `<link href="/assets/css/medivault-restyle.css">`
3. Added `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">`
4. Removed Lucide CDN script: `<script src="https://unpkg.com/lucide@0.451.0/dist/umd/lucide.min.js"></script>`
5. Icons now rendered by `mv-core.js` icon helper (FA classes)

**404.html special case:**
- Replaced `<i data-lucide="file-question">` with `<i class="fas fa-question-circle">` inline
- Removed `lucide.createIcons()` call
