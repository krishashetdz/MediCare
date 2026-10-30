# MediVault Launcher for PowerShell
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "            MediVault Hospital System              " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# 1. Check MySQL
Write-Host "`n[1/3] Checking MySQL database..." -ForegroundColor Yellow
$mysqlActive = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue

if (-not $mysqlActive) {
    Write-Host "MySQL is not running. Starting XAMPP MySQL..." -ForegroundColor Yellow
    if (Test-Path "C:\xampp\mysql\bin\mysqld.exe") {
        Start-Process -FilePath "C:\xampp\mysql\bin\mysqld.exe" -ArgumentList "--defaults-file=C:\xampp\mysql\bin\my.ini", "--standalone" -WindowStyle Hidden
        Start-Sleep -Seconds 3
        Write-Host "MySQL started successfully." -ForegroundColor Green
    } else {
        Write-Warning "C:\xampp\mysql\bin\mysqld.exe not found. Please ensure MySQL is listening on port 3306."
    }
} else {
    Write-Host "MySQL is running on port 3306." -ForegroundColor Green
}

# 2. Launch browser
Write-Host "`n[2/3] Opening browser at http://localhost:3000 ..." -ForegroundColor Yellow
Start-Process "http://localhost:3000"

# 3. Start Node application
Write-Host "`n[3/3] Starting MediVault application server..." -ForegroundColor Green
Set-Location (Join-Path $scriptDir "MediVault\06_Application")
node server.js
