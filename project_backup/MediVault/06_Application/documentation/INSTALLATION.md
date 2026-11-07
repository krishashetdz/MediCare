# Installation & How to Run from Scratch
## MediVault / MediCare Hospital Management System

### Prerequisites
- **Node.js**: v18+ (`node -v`, `npm -v`)
- **MariaDB 10.6+ or MySQL 8.0+**: running on `localhost:3306`
- **MongoDB 6.0+**: running on `localhost:27017`

---

### How to Run from Scratch

1. **Create Database and Load Schema & Seed Data**:
   ```bash
   cd project_backup/MediVault/06_Application
   mysql -u root -e "DROP DATABASE IF EXISTS medivault; CREATE DATABASE medivault CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
   mysql -u root medivault < db/schema.sql
   mysql -u root medivault < db/seed.sql
   ```

2. **Configure `.env`**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set a real `SESSION_SECRET` (note: `server.js` refuses to start with placeholder values like `'change-this-in-production'`):
   ```env
   MYSQL_HOST=localhost
   MYSQL_PORT=3306
   MYSQL_USER=root
   MYSQL_PASSWORD=
   MYSQL_DATABASE=medivault
   MONGO_URI=mongodb://localhost:27017
   SESSION_SECRET=9f8d7a6b5c4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a
   PORT=3000
   ```

3. **Install Dependencies & Start the Server**:
   ```bash
   npm install
   npm start
   ```
   To run under explicit timezones:
   ```bash
   TZ=Asia/Kolkata npm start
   # or
   TZ=UTC npm start
   ```

4. **Run the End-to-End Test Suite (`test-e2e.js`) & MongoDB Verification**:
   ```bash
   TZ=Asia/Kolkata node test-e2e.js
   TZ=UTC node test-e2e.js
   node scripts/verify-mongo.js
   ```

---

### Seed Login Credentials (`db/seed.sql`)

| Role | Email | Password |
| :--- | :--- | :--- |
| **Admin** | `admin@medivault.in` | `admin1` |
| **Doctor (Cardiology)** | `sharma.doc@medivault.in` | `doc1` |
| **Doctor (Orthopedics)** | `mehta.doc@medivault.in` | `doc2` |
| **Doctor (General Medicine)** | `iyer.doc@medivault.in` | `doc3` |
| **Doctor (Emergency Medicine)** | `bhosale.doc@medivault.in` | `doc4` |
| **Nurse** | `kavita.joshi@medivault.in` | `staff1` |
| **Lab Technician** | `arjun.pillai@medivault.in` | `staff2` |
| **Pharmacist** | `neha.kapoor@medivault.in` | `staff3` |
| **Receptionist** | `suresh.rao@medivault.in` | `staff4` |
| **Patient** | `rahul.verma@gmail.com` | `pat1` |
| **Patient** | `priya.nair@gmail.com` | `pat2` |
