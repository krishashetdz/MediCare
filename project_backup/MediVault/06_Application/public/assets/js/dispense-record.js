(function () {
    // Presentation only: aggregate requirements and projected stock come from
    // the existing item endpoint, matched to the database trigger calculation.
    MV.dispenseRecord = function (rx, items) {
        const medicines = [...new Map(items.map(it => [it.medicine_id, it])).values()];
        const shortage = medicines.some(it => Number(it.stock_after) < 0);
        const html = '<p class="rx-reference" data-testid="dispense-prescription-reference">Prescription #' + rx.prescription_id + ' &bull; Stock reconciliation</p>' +
          '<div class="rx-context"><div><small>Patient</small><p class="rx-patient" data-testid="dispense-patient-name">' + MV.esc(rx.patient_name) + '</p></div><div><small>Prescribed by</small><p>' + MV.esc(MV.fmt.docName(rx.doctor_name)) + '</p></div></div>' +
          '<table class="rx-reconciliation" data-testid="dispense-stock-table"><caption class="visually-hidden">Stock consequence by medicine</caption><thead><tr><th scope="col">Medicine</th><th scope="col">In stock</th><th scope="col">To dispense</th><th scope="col">Remaining</th></tr></thead><tbody>' +
          medicines.map(it => '<tr data-testid="dispense-medicine-' + it.medicine_id + '"><td>' + MV.esc(it.medicine_name) + '<small>' + items.filter(x => x.medicine_id === it.medicine_id).map(x => MV.esc(x.dosage || 'Not specified') + (x.instructions ? ' &bull; <strong style="color:var(--mv-text)">' + MV.esc(x.instructions) + '</strong>' : '') + ' &bull; ' + MV.esc(x.duration_days) + ' days &bull; ' + x.quantity + ' units').join('<br>') + '</small></td><td>' + it.current_stock + '</td><td>' + it.required_quantity + '</td><td class="rx-after ' + (Number(it.stock_after) < 0 ? 'rx-short' : '') + '">' + it.stock_after + '</td></tr>').join('') + '</tbody></table>' +
          '<div class="rx-safety ' + (shortage || !items.length ? 'is-error' : '') + '" role="status" data-testid="dispense-stock-validation">' + MV.icon(shortage ? 'triangle-alert' : 'shield') + '<span>' + (shortage ? 'Insufficient stock. This prescription cannot be dispensed.' : !items.length ? 'No medicine items recorded.' : 'Stock is sufficient. Quantities will be checked again at confirmation.') + '</span></div>';
        return { html, canDispense: items.length > 0 && !shortage };
    };
})();
