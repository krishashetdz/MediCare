# User Roles & Access Control Matrix
## MediVault / MediCare Role-Based Authorization Specifications

### Seed Login Credentials (`db/seed.sql`)

| Role | Name | Email | Seed Password | Primary Landing Page |
| :--- | :--- | :--- | :--- | :--- |
| **Admin** | Rohan Kulkarni | `admin@medivault.in` | `admin1` | `/admin-dashboard.html` |
| **Doctor** (Cardiology) | Dr. Aditi Sharma | `sharma.doc@medivault.in` | `doc1` | `/doctor-dashboard.html` |
| **Doctor** (Orthopedics) | Dr. Karan Mehta | `mehta.doc@medivault.in` | `doc2` | `/doctor-dashboard.html` |
| **Doctor** (General Medicine) | Dr. Lakshmi Iyer | `iyer.doc@medivault.in` | `doc3` | `/doctor-dashboard.html` |
| **Doctor** (Emergency Medicine) | Dr. Neha Bhosale | `bhosale.doc@medivault.in` | `doc4` | `/doctor-dashboard.html` |
| **Nurse** | Kavita Joshi | `kavita.joshi@medivault.in` | `staff1` | `/staff-portal.html` |
| **Lab Technician** | Arjun Pillai | `arjun.pillai@medivault.in` | `staff2` | `/staff-portal.html` |
| **Pharmacist** | Neha Kapoor | `neha.kapoor@medivault.in` | `staff3` | `/staff-portal.html` |
| **Receptionist** | Suresh Rao | `suresh.rao@medivault.in` | `staff4` | `/staff-portal.html` |
| **Patient** | Rahul Verma | `rahul.verma@gmail.com` | `pat1` | `/patient-portal.html` |
| **Patient** | Priya Nair | `priya.nair@gmail.com` | `pat2` | `/patient-portal.html` |
| **Patient** | Amit Deshmukh | `amit.deshmukh@gmail.com` | `pat3` | `/patient-portal.html` |
| **Patient** | Sneha Reddy | `sneha.reddy@gmail.com` | `pat4` | `/patient-portal.html` |
| **Patient** | Vikram Chauhan | `vikram.chauhan@gmail.com` | `pat5` | `/patient-portal.html` |
| **Patient** | Anjali Bhatt | `anjali.bhatt@gmail.com` | `pat6` | `/patient-portal.html` |

---

### Deliberate Role Design: Why Billing Staff and Emergency Staff Are Not Separate Roles

MediVault intentionally models **7 canonical roles** (`Admin`, `Doctor`, `Patient`, `Nurse`, `Lab Technician`, `Pharmacist`, `Receptionist`) in the `ROLE` table and `STAFF.staff_type` enum (`NURSE`, `LAB_TECHNICIAN`, `PHARMACIST`, `RECEPTIONIST`):

1. **Receptionist Covers Billing & Front-Desk Emergency Intake**:
   - In hospital front-desk operations, the same receptionist who registers a patient (`POST /api/staff/receptionist/register-patient`), books/reschedules/cancels appointments, or checks in an emergency arrival (`POST /api/emergency/register`, `POST /api/admin/ambulance/:id/dispatch`) also generates the visit invoice (`POST /api/staff/receptionist/generate-bill`) and records partial or full payments (`POST /api/billing/:billId/payments`). Splitting `Receptionist` and `Billing Staff` into separate logins would force front-desk personnel to log out and switch accounts mid-checkout.
2. **Nurse Covers Emergency Triage & Bed Allocation**:
   - Emergency clinical triage (`POST /api/emergency/triage/:id`), running the Signature Priority Engine (`GET /api/emergency/priority-engine/:id`), allocating emergency beds (`POST /api/emergency/allocate/:id`), and managing inpatient ward admissions (`POST /api/staff/nurse/assign-admission-bed`) are nursing responsibilities handled by `Nurse` (and `Doctor`/`Admin`), while clinical procedures and discharges (`POST /api/emergency/treatment/:id`, `POST /api/emergency/discharge/:id`) are restricted to `Doctor` and `Admin`.
