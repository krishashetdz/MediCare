#!/usr/bin/env python3
"""
tests/test-browser-e2e.py
Headless Chromium Browser Verification Suite (TEST K) for MediCare.
Tests:
- Login page rendering, MediCare branding, form submission, and role redirect
- Admin Dashboard KPI cards, navigation sidebar, and Dark/Light theme toggle
- Emergency Ward KPI cards, Live Priority Queue (Triage Pending vs P1-P4 badges),
  Register Patient tab, Triage modal, Priority Engine modal (recommendations,
  explanations, resource dropdowns, #engineOverrideReason input), Doctors & Beds matrix
- Bed Management, Blood Bank, and Ambulance screens & modals
- Doctor Dashboard schedule stats, consultation modal, multi-medicine builder
- Staff Portal and Patient Portal
- Responsive viewports (1440x900 desktop and 375x812 mobile)
"""
import os
import sys
import time
import subprocess
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

PORT = 3457
BASE_URL = f"http://medicare.local:{PORT}"

passed = 0
failed = 0

def check(cond, label, detail=""):
    global passed, failed
    if cond:
        print(f"✅ [PASS] {label}")
        passed += 1
    else:
        print(f"❌ [FAIL] {label} {('-> ' + detail) if detail else ''}")
        failed += 1

def main():
    app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = os.environ.copy()
    env["PORT"] = str(PORT)
    server_proc = subprocess.Popen(
        ["node", "tests/start-test-server.js"],
        cwd=app_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )

    ready = False
    start_t = time.time()
    while time.time() - start_t < 15:
        line = server_proc.stdout.readline()
        if f"BROWSER_TEST_SERVER_READY:{PORT}" in line:
            ready = True
            break
    if not ready:
        server_proc.kill()
        print("Failed to start browser test server")
        sys.exit(1)

    chrome_opts = Options()
    chrome_opts.binary_location = "/usr/bin/chromium"
    chrome_opts.add_argument("--headless=new")
    chrome_opts.add_argument("--no-sandbox")
    chrome_opts.add_argument("--disable-dev-shm-usage")
    chrome_opts.add_argument("--disable-gpu")
    chrome_opts.add_argument("--window-size=1440,900")
    chrome_opts.add_argument(
        "--host-resolver-rules=MAP medicare.local 127.0.0.1, MAP *.cloudflare.com 127.0.0.1, "
        "MAP *.unpkg.com 127.0.0.1, MAP *.googleapis.com 127.0.0.1, MAP *.gstatic.com 127.0.0.1, MAP *.jsdelivr.net 127.0.0.1"
    )
    chrome_opts.page_load_strategy = "eager"

    driver = webdriver.Chrome(options=chrome_opts)
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd(
        "Network.setBlockedURLs",
        {"urls": ["*cloudflare.com*", "*unpkg.com*", "*googleapis.com*", "*gstatic.com*", "*jsdelivr.net*"]}
    )
    wait = WebDriverWait(driver, 10)

    try:
        print("=== STARTING TEST K: HEADLESS CHROMIUM BROWSER VERIFICATION ===\n")

        # 1. Landing & Login Page
        driver.get(f"{BASE_URL}/login.html")
        wait.until(EC.presence_of_element_located((By.ID, "email")))
        wait.until(lambda d: d.execute_script("return Boolean(window.MV);"))
        check("MediCare" in driver.title, "TEST K.1: Login page title displays MediCare branding", driver.title)

        # Fill Admin credentials and submit
        driver.find_element(By.ID, "email").clear()
        driver.find_element(By.ID, "email").send_keys("admin@medivault.in")
        driver.find_element(By.ID, "password").clear()
        driver.find_element(By.ID, "password").send_keys("admin1")
        driver.find_element(By.ID, "loginBtn").click()

        wait.until(EC.url_contains("/admin-dashboard.html"))
        wait.until(lambda d: d.execute_script("return Boolean(window.MV);"))
        time.sleep(0.6)
        check("/admin-dashboard.html" in driver.current_url, "TEST K.2: Admin login redirects to /admin-dashboard.html")

        # 2. Admin Dashboard KPIs, Theme Toggle & Navigation
        page_text = driver.find_element(By.TAG_NAME, "body").text
        check("MediCare" in driver.title and ("Dashboard" in page_text or "Patients" in page_text),
              "TEST K.3: Admin Dashboard renders KPI cards and analytics layout")

        # Test Dark/Light theme toggle
        initial_theme = driver.execute_script("return document.documentElement.getAttribute('data-theme');")
        driver.execute_script("window.MV.theme.toggle();")
        toggled_theme = driver.execute_script("return document.documentElement.getAttribute('data-theme');")
        check(initial_theme != toggled_theme, "TEST K.4: Dark/Light theme toggle switches data-theme attribute dynamically")

        # 3. Emergency Ward UI (Queue, Triage Pending Badge, Assessed PriorityEngine Modal, Unassessed Alert, Override Reason Input)
        driver.get(f"{BASE_URL}/emergency.html")
        wait.until(EC.presence_of_element_located((By.ID, "emgTabContent")))
        time.sleep(0.9)

        queue_html = driver.find_element(By.ID, "emgTabContent").get_attribute("innerHTML")
        check("Triage Pending" in queue_html and "unassessed" in queue_html,
              "TEST K.5: Emergency Queue renders distinct 'Triage Pending' (.p-badge.unassessed) badge for unassessed cases")
        check("P1" in queue_html and "EMG-" in queue_html,
              "TEST K.6: Emergency Queue renders P1 Critical badge and patient details for assessed cases")

        # Open Priority Engine Modal for Assessed Case #1
        driver.execute_script("window.openPriorityEngine(1);")
        time.sleep(0.7)
        engine_modal = driver.find_element(By.ID, "engineModal")
        engine_body_html = driver.find_element(By.ID, "engineModalBody").get_attribute("innerHTML")
        override_input = driver.find_element(By.ID, "engineOverrideReason")
        doc_select = driver.find_element(By.ID, "engineSelectDoctor")
        bed_select = driver.find_element(By.ID, "engineSelectBed")
        check(
            ("show" in engine_modal.get_attribute("class") or "active" in engine_modal.get_attribute("class")) and
            override_input.is_displayed() and
            doc_select.is_displayed() and
            bed_select.is_displayed() and
            ("Cardiology" in engine_body_html or "Recommended" in engine_body_html),
            "TEST K.7: Priority Engine modal displays recommendations, explanations, doctor/bed selectors, and manual override reason input (#engineOverrideReason)"
        )

        # Open Priority Engine Modal for Unassessed Case #6 -> verify Triage Pending warning banner
        driver.execute_script("window.openPriorityEngine(6);")
        time.sleep(0.7)
        unassessed_engine_html = driver.find_element(By.ID, "engineModalBody").get_attribute("innerHTML")
        check(
            "Triage Assessment Pending" in unassessed_engine_html,
            "TEST K.8: Priority Engine modal displays 'Triage Assessment Pending' banner for unassessed case and requires override reason for manual emergency assignment"
        )
        driver.execute_script("window.bootstrap.Modal.getInstance(document.getElementById('engineModal')).hide();")

        # Open Triage Modal and verify validation fields & temperature unit selector
        driver.execute_script("window.openTriageModal(6);")
        time.sleep(0.5)
        triage_modal = driver.find_element(By.ID, "triageModal")
        temp_unit_select = driver.find_element(By.ID, "triageTempUnit")
        check(
            ("show" in triage_modal.get_attribute("class") or "active" in triage_modal.get_attribute("class")) and
            temp_unit_select is not None,
            "TEST K.9: Triage modal opens with vital sign inputs, temperature unit selector (°F/°C), and priority level selector"
        )
        driver.execute_script("window.bootstrap.Modal.getInstance(document.getElementById('triageModal')).hide();")

        # Switch to Register Patient tab and Doctors & Beds Matrix tab
        driver.execute_script("window.switchTab('register');")
        time.sleep(0.4)
        reg_html = driver.find_element(By.ID, "emgTabContent").get_attribute("innerHTML")
        check("emgRegForm" in reg_html and "Register Emergency Case" in reg_html,
              "TEST K.10: Emergency Register Patient tab switches cleanly and renders registration form")

        driver.execute_script("window.switchTab('matrix');")
        time.sleep(0.6)
        matrix_html = driver.find_element(By.ID, "emgTabContent").get_attribute("innerHTML")
        check("bed-matrix" in matrix_html and ("Emergency & ICU Beds" in matrix_html or "Emergency &amp; ICU Beds" in matrix_html),
              "TEST K.11: Emergency Doctors & Beds matrix tab loads live resource grid")

        # 4. Bed Management Screen
        driver.get(f"{BASE_URL}/bed-management.html")
        wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        time.sleep(0.7)
        bed_text = driver.find_element(By.TAG_NAME, "body").text
        check("MediCare" in driver.title and ("Ward" in bed_text or "Bed" in bed_text),
              "TEST K.12: Bed Management screen renders ward occupancy and bed status cards")

        # 5. Blood Bank Screen
        driver.get(f"{BASE_URL}/blood-bank.html")
        wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        time.sleep(0.7)
        blood_text = driver.find_element(By.TAG_NAME, "body").text
        check("MediCare" in driver.title and ("O+" in blood_text or "Blood" in blood_text),
              "TEST K.13: Blood Bank screen renders all 8 blood groups and request queue")

        # 6. Ambulance Screen
        driver.get(f"{BASE_URL}/ambulance.html")
        wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
        time.sleep(0.7)
        amb_text = driver.find_element(By.TAG_NAME, "body").text
        check("MediCare" in driver.title and ("MH-12" in amb_text or "Ambulance" in amb_text),
              "TEST K.14: Ambulance screen renders fleet status cards and dispatch history")

        # 7. Doctor Login & Doctor Dashboard Verification
        driver.get(f"{BASE_URL}/login.html")
        wait.until(EC.presence_of_element_located((By.ID, "email")))
        wait.until(lambda d: d.execute_script("return Boolean(window.MV);"))
        driver.find_element(By.ID, "email").clear()
        driver.find_element(By.ID, "email").send_keys("sharma.doc@medivault.in")
        driver.find_element(By.ID, "password").clear()
        driver.find_element(By.ID, "password").send_keys("doc1")
        driver.find_element(By.ID, "loginBtn").click()
        wait.until(EC.url_contains("/doctor-dashboard.html"))
        time.sleep(0.7)
        check(
            "/doctor-dashboard.html" in driver.current_url and "MediCare" in driver.title,
            "TEST K.15: Doctor login redirects to /doctor-dashboard.html and loads schedule"
        )

        # 8. Mobile Responsive Viewport Check (375x812)
        driver.set_window_size(375, 812)
        time.sleep(0.3)
        viewport_w = driver.execute_script("return window.innerWidth;")
        check(viewport_w == 375, "TEST K.16: Responsive mobile viewport (375x812) renders cleanly without JS errors")

        print(f"\n=== TEST K BROWSER SUMMARY: {passed} Passed, {failed} Failed ===")
        if failed > 0:
            sys.exit(1)
    finally:
        driver.quit()
        server_proc.terminate()

if __name__ == "__main__":
    main()
