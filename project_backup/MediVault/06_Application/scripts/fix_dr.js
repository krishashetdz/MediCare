const fs = require('fs');
const path = require('path');

const basePath = 'C:/Users/krisj/Desktop/MediVault/project_backup/MediVault/06_Application';

// 1. lab.html
const labFile = path.join(basePath, 'public/lab.html');
if (fs.existsSync(labFile)) {
    let lab = fs.readFileSync(labFile, 'utf8');
    lab = lab.replace(/Requested by Dr\.\s*'\s*\+\s*MV\.esc\(req\.requested_by\)/g, "Requested by ' + MV.esc(MV.fmt.docName(req.requested_by))");
    lab = lab.replace(/<strong>Requested by:<\/strong>\s*Dr\.\s*'\s*\+\s*MV\.esc\(req\.requested_by\)/g, "<strong>Requested by:</strong> ' + MV.esc(MV.fmt.docName(req.requested_by))");
    fs.writeFileSync(labFile, lab, 'utf8');
    console.log('Fixed lab.html');
}

// 2. pharmacy.html
const pharmFile = path.join(basePath, 'public/pharmacy.html');
if (fs.existsSync(pharmFile)) {
    let pharm = fs.readFileSync(pharmFile, 'utf8');
    pharm = pharm.replace(/Dr\.\s*'\s*\+\s*MV\.esc\(rx\.doctor_name\)/g, "MV.esc(MV.fmt.docName(rx.doctor_name))");
    fs.writeFileSync(pharmFile, pharm, 'utf8');
    console.log('Fixed pharmacy.html');
}

// 3. patient-reports.html
const reportsFile = path.join(basePath, 'public/patient-reports.html');
if (fs.existsSync(reportsFile)) {
    let rep = fs.readFileSync(reportsFile, 'utf8');
    rep = rep.replace(/Dr\.\s*'\s*\+\s*MV\.esc\(c\.doctor_name\)/g, "MV.esc(MV.fmt.docName(c.doctor_name))");
    rep = rep.replace(/Dr\.\s*'\s*\+\s*MV\.esc\(p\.doctor_name\)/g, "MV.esc(MV.fmt.docName(p.doctor_name))");
    fs.writeFileSync(reportsFile, rep, 'utf8');
    console.log('Fixed patient-reports.html');
}

