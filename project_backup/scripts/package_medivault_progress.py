"""Package only MediVault changes against the user's uploaded archive."""
from pathlib import Path
import difflib
import hashlib
import json
import zipfile

ROOT = Path('/app/MediVault')
SOURCE = Path('/tmp/MediVault.zip')
OUTPUT = ROOT / '06_Application/public/assets/downloads'
OUTPUT.mkdir(parents=True, exist_ok=True)
EXCLUDED = {'node_modules', '.git', 'downloads', '__pycache__'}
original = {}
with zipfile.ZipFile(SOURCE) as source:
    for item in source.infolist():
        path = Path(item.filename)
        if item.is_dir() or path.parts[0] != 'MediVault' or EXCLUDED.intersection(path.parts):
            continue
        relative = path.relative_to('MediVault').as_posix()
        if path.name == '.env':
            continue
        original[relative] = source.read(item)

changed = {}
for file in ROOT.rglob('*'):
    if not file.is_file() or EXCLUDED.intersection(file.parts) or file.name == '.env':
        continue
    relative = file.relative_to(ROOT).as_posix()
    # This is a hosting adapter only, not part of the user's portable app.
    if relative == '06_Application/config/preview-start.js':
        continue
    content = file.read_bytes()
    if original.get(relative) != content:
        changed[relative] = content

notes = '''# MediVault — changes so far (partial handoff)

This is an IN-PROGRESS snapshot requested before implementation and verification
were completed. It is not a completed or fully tested release.

## Apply the ZIP (easiest)
1. Back up your existing MediVault folder and both databases.
2. Stop the running application.
3. Extract this ZIP. Copy its 05_MongoDB, 06_Application and 07_Report folders
   INTO your existing MediVault folder, merging folders and replacing matching
   files. Also copy 03_Queries and 04_Views_Triggers_Procs when present.
   Do not create a nested MediVault/MediVault directory.
4. Keep your existing 06_Application/.env. No credentials or environment files
   are included or overwritten.
5. In 06_Application, run `yarn install`, then `yarn start` (or your usual start
   command). The added dependency is express-async-errors. Do not copy node_modules.

## Alternative: unified patch
From inside your original MediVault folder, run:
    git apply --check /path/to/medivault-changes-so-far.patch
    git apply /path/to/medivault-changes-so-far.patch
Apply EITHER the ZIP OR the patch, not both. The patch targets the exact uploaded
archive; applying to a subsequently edited copy may cause conflicts.

## Database changes: read before starting
The revised dispense UI needs the updated prescription-items API, and the
updated stock trigger in 04_Views_Triggers_Procs. The doctor's schedule view
also now exposes patient_id.

For an EXISTING database: do not rerun the full schema/seed scripts. They include
destructive DROP DATABASE and non-idempotent sample inserts. Back up first, then
apply only CREATE OR REPLACE VIEW vw_doctor_today_schedule and replace
trg_update_stock (DROP TRIGGER IF EXISTS trg_update_stock, followed by its revised
CREATE TRIGGER block). Use the DELIMITER directives around the trigger block.
No automatic existing-database migration was completed before this handoff.

For a DISPOSABLE, fresh demo database only: the documented load order remains
02_DDL_DML, 03_Queries, then 04_Views_Triggers_Procs core SQL.

## Included work
- Saved the approved design brief before UI changes.
- Added the clinical-record stylesheet and shared accessibility/theme helpers;
  linked all twelve working screens, plus the supporting 404 screen.
- Added receptionist appointment/billing interaction calling sp_generate_bill,
  generated-bill response and patient portal bill links.
- Added the dispense reconciliation display and server-derived aggregated
  quantity/remaining-stock fields; revised the stock trigger for repeated
  medicines and read actual stock after dispensing.
- Added MongoDB core/extended headings and an executable constraint demo with
  expected-error handlers and rollback.
- Repaired several pre-existing rendering/wiring issues discovered along the
  way, including the missing MV.table helper, toast message options, nurse bed
  data, registration gender values, and shared resource permission mismatches.

## What was actually run
- Installed and started real MySQL Community Server 8.4.11.
- Executed DDL/DML, the complete query file (including constraint failures and
  corrections), and the views/triggers/procedures SQL without script errors.
- Started the application; the login page returned HTTP 200 and the Admin login
  API succeeded against the live server.

## Not finished / not yet verified
- 07_Report/medivault_phase7_report.docx has NOT been renumbered. It is unchanged
  and therefore not included in this patch. Only the design brief was added.
- The twelve-screen visual self-critique, browser workflow testing, mobile and
  dark-mode checks, keyboard/focus review and print verification remain undone.
- Bill generation -> staff billing -> patient billing and the revised dispense
  UI have NOT yet been verified end to end.
- Constraint tests have not yet been repeated after ALL subsequent application
  changes, and no completed regression-test report is supplied.
- MongoDB core/extended labeling is preliminary: the archive's existing
  Experiment 9 mapping was used; no separate syllabus attachment was available.
- Some inherited limitations and further defects may remain. Preserve backups
  and treat this as an unfinished development snapshot.

## Portability
The preview-only React/FastAPI proxy, supervisor configuration, downloaded MySQL
binaries, environment files, dependencies and database contents are excluded.
The actual Express application stays in its original folder structure. Its
runtime-config.js endpoint uses the current origin when REACT_APP_BACKEND_URL
is unset, so no preview URL is embedded in this patch.

FILES_CHANGED.json lists the included files and their SHA-256 checksums.
'''

patch_parts = []
for relative, content in sorted(changed.items()):
    before = original.get(relative, b'')
    old = before.decode('utf-8').splitlines(keepends=True)
    new = content.decode('utf-8').splitlines(keepends=True)
    patch_parts.append('diff --git a/' + relative + ' b/' + relative + '\n')
    if relative not in original:
        patch_parts.append('new file mode 100644\n')
    patch_parts.extend(difflib.unified_diff(old, new,
        fromfile='a/' + relative if relative in original else '/dev/null',
        tofile='b/' + relative))

patch_file = OUTPUT / 'medivault-changes-so-far.patch'
patch_file.write_text(''.join(patch_parts))
manifest = {path: {'change':'modified' if path in original else 'added',
                   'sha256':hashlib.sha256(data).hexdigest()}
            for path,data in sorted(changed.items())}
with zipfile.ZipFile(OUTPUT / 'medivault-changes-so-far.zip','w',zipfile.ZIP_DEFLATED) as package:
    for path,data in sorted(changed.items()):
        package.writestr(path,data)
    package.writestr('PATCH_NOTES.md',notes)
    package.writestr('FILES_CHANGED.json',json.dumps(manifest,indent=2)+'\n')
(OUTPUT/'PATCH_NOTES.md').write_text(notes)
print(json.dumps({'changed_files':len(changed),'files':list(sorted(changed)),
    'zip_bytes':(OUTPUT/'medivault-changes-so-far.zip').stat().st_size,
    'patch_bytes':patch_file.stat().st_size},indent=2))