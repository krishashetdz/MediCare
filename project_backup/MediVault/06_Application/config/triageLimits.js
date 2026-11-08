/**
 * config/triageLimits.js
 * Configurable technical validation limits for Triage Assessment and Patient Vitals inputs.
 */

const TRIAGE_LIMITS = {
    bp_systolic: {
        min: Number(process.env.TRIAGE_BP_SYS_MIN) || 40,
        max: Number(process.env.TRIAGE_BP_SYS_MAX) || 280,
        unit: 'mmHg',
        label: 'Systolic Blood Pressure'
    },
    bp_diastolic: {
        min: Number(process.env.TRIAGE_BP_DIA_MIN) || 20,
        max: Number(process.env.TRIAGE_BP_DIA_MAX) || 190,
        unit: 'mmHg',
        label: 'Diastolic Blood Pressure'
    },
    heart_rate: {
        min: Number(process.env.TRIAGE_HR_MIN) || 20,
        max: Number(process.env.TRIAGE_HR_MAX) || 260,
        unit: 'BPM',
        label: 'Heart Rate'
    },
    spo2: {
        min: Number(process.env.TRIAGE_SPO2_MIN) || 40,
        max: Number(process.env.TRIAGE_SPO2_MAX) || 100,
        unit: '%',
        label: 'Oxygen Saturation (SpO2)'
    },
    temperature_F: {
        min: Number(process.env.TRIAGE_TEMP_F_MIN) || 82.0,
        max: Number(process.env.TRIAGE_TEMP_F_MAX) || 112.0,
        unit: 'F',
        label: 'Temperature (°F)'
    },
    temperature_C: {
        min: Number(process.env.TRIAGE_TEMP_C_MIN) || 28.0,
        max: Number(process.env.TRIAGE_TEMP_C_MAX) || 44.5,
        unit: 'C',
        label: 'Temperature (°C)'
    },
    respiratory_rate: {
        min: Number(process.env.TRIAGE_RR_MIN) || 4,
        max: Number(process.env.TRIAGE_RR_MAX) || 70,
        unit: 'breaths/min',
        label: 'Respiratory Rate'
    },
    gcs_score: {
        min: 3,
        max: 15,
        unit: 'points',
        label: 'Glasgow Coma Scale (GCS)'
    },
    consciousness_levels: ['Alert', 'Voice', 'Verbal', 'Pain', 'Unresponsive'],
    priorities: ['P1', 'P2', 'P3', 'P4']
};

function parseNumericField(rawVal, fieldSpec, required = false, integerOnly = true) {
    if (rawVal === undefined || rawVal === null || rawVal === '') {
        if (required) {
            return { error: `${fieldSpec.label} is required (${fieldSpec.min}–${fieldSpec.max} ${fieldSpec.unit})` };
        }
        return { value: null };
    }
    if (typeof rawVal === 'boolean' || Array.isArray(rawVal) || typeof rawVal === 'object') {
        return { error: `${fieldSpec.label} must be a valid number` };
    }
    const num = Number(rawVal);
    if (!Number.isFinite(num)) {
        return { error: `${fieldSpec.label} must be a finite number` };
    }
    if (integerOnly && !Number.isInteger(num)) {
        return { error: `${fieldSpec.label} must be an integer value` };
    }
    if (num < fieldSpec.min || num > fieldSpec.max) {
        return {
            error: `${fieldSpec.label} (${num} ${fieldSpec.unit}) is outside configurable technical validation limits (${fieldSpec.min}–${fieldSpec.max} ${fieldSpec.unit})`
        };
    }
    return { value: num };
}

function validateTriagePayload(payload = {}, options = {}) {
    const { requireTriageFields = true } = options;
    const errors = [];

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, errors: ['Request payload must be a valid JSON object'] };
    }

    if (requireTriageFields) {
        if (!payload.priority || !TRIAGE_LIMITS.priorities.includes(payload.priority)) {
            errors.push('Valid triage priority (P1, P2, P3, or P4) is required');
        }
        const hasSymptoms = typeof payload.symptoms === 'string' && payload.symptoms.trim().length > 0;
        const hasNotes = typeof payload.assessment_notes === 'string' && payload.assessment_notes.trim().length > 0;
        const hasInjury = typeof payload.injury_details === 'string' && payload.injury_details.trim().length > 0;
        if (!hasSymptoms && !hasNotes && !hasInjury) {
            errors.push('At least one clinical observation field (symptoms, injury_details, or assessment_notes) is required');
        }
        if (payload.consciousness_level !== undefined && payload.consciousness_level !== null && payload.consciousness_level !== '') {
            if (!TRIAGE_LIMITS.consciousness_levels.includes(payload.consciousness_level)) {
                errors.push(`Invalid consciousness_level. Allowed values: ${TRIAGE_LIMITS.consciousness_levels.join(', ')}`);
            }
        }
    }

    const sysRes = parseNumericField(payload.bp_systolic, TRIAGE_LIMITS.bp_systolic, requireTriageFields, true);
    if (sysRes.error) errors.push(sysRes.error);

    const diaRes = parseNumericField(payload.bp_diastolic, TRIAGE_LIMITS.bp_diastolic, requireTriageFields, true);
    if (diaRes.error) errors.push(diaRes.error);

    if (sysRes.value !== null && diaRes.value !== null && sysRes.value <= diaRes.value) {
        errors.push(`Systolic blood pressure (${sysRes.value} mmHg) must be greater than diastolic blood pressure (${diaRes.value} mmHg)`);
    }
    if ((sysRes.value !== null && diaRes.value === null) || (sysRes.value === null && diaRes.value !== null)) {
        errors.push('Both systolic and diastolic blood pressure values must be provided together');
    }

    const hrRes = parseNumericField(payload.heart_rate, TRIAGE_LIMITS.heart_rate, requireTriageFields, true);
    if (hrRes.error) errors.push(hrRes.error);

    const spo2Res = parseNumericField(payload.spo2, TRIAGE_LIMITS.spo2, requireTriageFields, true);
    if (spo2Res.error) errors.push(spo2Res.error);

    const rawUnit = payload.temperature_unit !== undefined && payload.temperature_unit !== null && payload.temperature_unit !== ''
        ? String(payload.temperature_unit).trim().toUpperCase().replace('°', '')
        : 'F';
    if (!['F', 'C'].includes(rawUnit)) {
        errors.push("Invalid temperature_unit. Specify 'F' (°F) or 'C' (°C)");
    }
    const tempSpec = rawUnit === 'C' ? TRIAGE_LIMITS.temperature_C : TRIAGE_LIMITS.temperature_F;
    const tempRes = parseNumericField(payload.temperature, tempSpec, false, false);
    if (tempRes.error) errors.push(tempRes.error);

    let normalizedTempF = tempRes.value;
    if (normalizedTempF !== null && rawUnit === 'C') {
        normalizedTempF = Number(((normalizedTempF * 9) / 5 + 32).toFixed(1));
    }

    const rrRes = parseNumericField(payload.respiratory_rate, TRIAGE_LIMITS.respiratory_rate, false, true);
    if (rrRes.error) errors.push(rrRes.error);

    const gcsRes = parseNumericField(payload.gcs_score, TRIAGE_LIMITS.gcs_score, false, true);
    if (gcsRes.error) errors.push(gcsRes.error);

    return {
        valid: errors.length === 0,
        errors,
        normalized: {
            bp_systolic: sysRes.value,
            bp_diastolic: diaRes.value,
            heart_rate: hrRes.value,
            spo2: spo2Res.value,
            temperature: normalizedTempF,
            temperature_unit: rawUnit,
            respiratory_rate: rrRes.value,
            consciousness_level: payload.consciousness_level || 'Alert',
            gcs_score: gcsRes.value,
            priority: payload.priority || null,
            priority_reason: payload.priority_reason ? String(payload.priority_reason).trim() : null,
            symptoms: payload.symptoms ? String(payload.symptoms).trim() : null,
            injury_details: payload.injury_details ? String(payload.injury_details).trim() : null,
            assessment_notes: payload.assessment_notes ? String(payload.assessment_notes).trim() : null
        }
    };
}

module.exports = { TRIAGE_LIMITS, validateTriagePayload };
