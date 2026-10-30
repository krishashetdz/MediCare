# Installation & Run Instructions
## MediCare / MediVault Hospital & Emergency Management System

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **MariaDB / MySQL**: 10.4 or higher (running on port 3306)
- **MongoDB**: 6.0 or higher (running on port 27017, optional with graceful degradation)

---

### Step-by-Step Setup

1. **Clone or Navigate to the Workspace**:
   ```bash
   cd project_backup/MediVault/06_Application
   ```

2. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Configure connection credentials:
   ```env
   PORT=3000
   MYSQL_HOST=localhost
   MYSQL_PORT=3306
   MYSQL_USER=root
   MYSQL_PASSWORD=
   MYSQL_DATABASE=medivault
   MONGO_URI=mongodb://localhost:27017/medivault
   SESSION_SECRET=your_secure_random_session_secret_here
   ```

3. **Install Dependencies**:
   ```bash
   npm install
   ```

4. **Initialize Database & Run Migrations**:
   Run the SQL scripts in MariaDB/MySQL:
   ```bash
   # Execute core schema & stored procedures
   mysql -u root medivault < ../02_DDL_DML/01_schema.sql
   mysql -u root medivault < ../04_Views_Triggers_Procs/01_views.sql
   mysql -u root medivault < ../04_Views_Triggers_Procs/02_triggers.sql
   mysql -u root medivault < ../04_Views_Triggers_Procs/03_procedures.sql

   # Execute Emergency Ward & Blood Bank migrations
   mysql -u root medivault < migrations/emergency_schema.sql
   mysql -u root medivault < migrations/emergency_seed.sql
   ```

5. **Start Application Server**:
   ```bash
   node server.js
   ```
   The application is now live at: `http://localhost:3000`

6. **Run End-to-End Verification Test Suite**:
   ```bash
   node test-e2e.js
   ```

