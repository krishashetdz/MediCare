@echo off
setlocal
echo ===================================================
echo             MediVault Hospital System              
echo ===================================================
echo.

cd /d "%~dp0"

:: 1. Check if MySQL is running on port 3306
echo [1/3] Checking MySQL database status...
netstat -ano | findstr /R /C:":3306 " >nul
if %errorlevel% neq 0 (
    echo MySQL is not running. Starting XAMPP MySQL daemon...
    if exist "C:\xampp\mysql\bin\mysqld.exe" (
        start "" /B "C:\xampp\mysql\bin\mysqld.exe" --defaults-file="C:\xampp\mysql\bin\my.ini" --standalone
        timeout /t 3 /nobreak >nul
        echo MySQL started successfully.
    ) else (
        echo [WARNING] C:\xampp\mysql\bin\mysqld.exe not found. Please ensure MySQL is running on port 3306.
    )
) else (
    echo MySQL is already running on port 3306.
)

:: 2. Launch browser
echo.
echo [2/3] Preparing browser at http://localhost:3000 ...
start http://localhost:3000

:: 3. Start Node application
echo.
echo [3/3] Starting MediVault application server...
echo Pointing to MediVault/06_Application/server.js
echo.
cd "%~dp0MediVault\06_Application"
node server.js

pause
