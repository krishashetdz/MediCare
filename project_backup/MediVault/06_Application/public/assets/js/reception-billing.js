(function () {
    MV.receptionBilling = function (container) {
        container.innerHTML =
            '<section class="mv-card">' +
                '<div class="mv-card-head"><h2>Appointments & billing</h2><a class="mv-btn mv-btn-outline" href="/billing.html" data-testid="reception-all-bills">Billing ledger</a></div>' +
                '<div id="receptionAppointments"></div>' +
                '<div id="billResult" role="status" aria-live="polite" data-testid="reception-bill-result"></div>' +
            '</section>' +
            '<div class="modal fade" id="rescheduleApptModal" tabindex="-1">' +
                '<div class="modal-dialog">' +
                    '<div class="modal-content">' +
                        '<div class="modal-header">' +
                            '<h5 class="modal-title">Reschedule Appointment</h5>' +
                            '<button type="button" class="btn-close" data-bs-dismiss="modal"></button>' +
                        '</div>' +
                        '<div class="modal-body">' +
                            '<form id="rescheduleApptForm">' +
                                '<input type="hidden" id="reschedApptId" name="appointment_id">' +
                                '<div class="mb-3">' +
                                    '<label class="form-label">Patient & Doctor</label>' +
                                    '<input type="text" class="form-control" id="reschedSummary" readonly>' +
                                '</div>' +
                                '<div class="mb-3">' +
                                    '<label class="form-label">New Date <span class="text-danger">*</span></label>' +
                                    '<input type="date" class="form-control" id="reschedDate" name="appointment_date" required>' +
                                '</div>' +
                                '<div class="mb-3">' +
                                    '<label class="form-label">New Time <span class="text-danger">*</span></label>' +
                                    '<input type="time" class="form-control" id="reschedTime" name="appointment_time" required>' +
                                '</div>' +
                            '</form>' +
                        '</div>' +
                        '<div class="modal-footer">' +
                            '<button type="button" class="mv-btn mv-btn-outline" data-bs-dismiss="modal">Cancel</button>' +
                            '<button type="button" class="mv-btn mv-btn-primary" id="confirmRescheduleBtn" data-testid="confirm-reschedule-btn">Save New Slot</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</div>';

        const reschedModalEl = container.querySelector('#rescheduleApptModal');
        const reschedModal = window.bootstrap ? new bootstrap.Modal(reschedModalEl) : null;

        const table = new MV.DataTable(container.querySelector('#receptionAppointments'), {
            columns: [
                {key:'appointment_id',label:'Visit',render:r=>'#'+r.appointment_id},
                {key:'patient_name',label:'Patient'}, {key:'doctor_name',label:'Doctor'},
                {key:'appointment_date',label:'Date',render:r=>MV.fmt.date(r.appointment_date)+' · '+MV.fmt.time(r.appointment_time)},
                {key:'status',label:'Status',render:r=>MV.badge(r.status)}
            ],
            fetch:()=>MV.api.get('/api/staff/receptionist/appointments'),
            searchKeys:['patient_name','doctor_name','appointment_id'],
            searchPlaceholder:'Find patient, doctor or visit…',
            pageSize:10,
            rowActions:r=>{
                const billAction = r.bill_id
                    ? '<a class="mv-btn mv-btn-outline mv-btn-sm" data-testid="appointment-'+r.appointment_id+'-view-bill" href="/billing.html?id='+r.bill_id+'">View bill #'+r.bill_id+'</a>'
                    : r.consultation_id
                    ? '<button class="mv-btn mv-btn-primary mv-btn-sm" data-generate-bill="'+r.appointment_id+'" data-testid="appointment-'+r.appointment_id+'-generate-bill">'+MV.icon('file-invoice')+'Generate Bill</button>'
                    : '<span class="text-muted me-2" data-testid="appointment-'+r.appointment_id+'-billing-pending">Awaiting consultation</span>';
                const canModify = ['Scheduled', 'Confirmed', 'Checked In'].includes(r.status);
                const slotActions = canModify
                    ? ' <button type="button" class="mv-btn mv-btn-outline mv-btn-sm" data-reschedule-appt="'+r.appointment_id+'" data-testid="appointment-'+r.appointment_id+'-reschedule">Reschedule</button>' +
                      ' <button type="button" class="mv-btn mv-btn-ghost mv-btn-sm text-danger" data-cancel-appt="'+r.appointment_id+'" data-testid="appointment-'+r.appointment_id+'-cancel">Cancel</button>'
                    : '';
                return billAction + slotActions;
            },
            empty:{title:'No appointments',text:'No visits on record.'}
        });

        container.addEventListener('click',async event=>{
            const genBtn=event.target.closest('[data-generate-bill]');
            if(genBtn && !genBtn.disabled) {
                const id=Number(genBtn.dataset.generateBill);
                const appointment=table.getRows().find(r=>r.appointment_id===id);
                if(!appointment) return;
                const confirmed=await MV.confirm({title:'Generate bill for '+appointment.patient_name+'?',message:'Visit #'+id+' · '+MV.fmt.date(appointment.appointment_date)+'. Charges will include the recorded consultation, lab tests and prescribed medicines.',confirmText:'Generate Bill',kind:'primary'});
                if(!confirmed) return;
                const restore=MV.pending(genBtn,'Generating…');
                const result=container.querySelector('#billResult');
                result.textContent='Generating bill for visit #'+id+'…';
                try {
                    const response=await MV.api.post('/api/staff/receptionist/generate-bill',{appointment_id:id});
                    const bill=response.bill || response;
                    if(bill && bill.bill_id) {
                        result.innerHTML='<div class="rx-safety">'+MV.icon('circle-check')+'<span>Bill #'+bill.bill_id+' generated for '+MV.esc(appointment.patient_name)+' · '+MV.fmt.money(bill.total_amount)+'</span><a href="/billing.html?id='+bill.bill_id+'" class="mv-btn mv-btn-outline mv-btn-sm" data-testid="generated-bill-open">Open bill</a></div>';
                        MV.toast.success('Bill #'+bill.bill_id+' generated');
                    } else {
                        MV.toast.success('Bill generated successfully');
                    }
                    await table.reload();
                } catch(error) {
                    result.innerHTML='<p class="text-danger" role="alert" data-testid="generate-bill-error">'+MV.esc(error.message)+'</p>';
                    MV.toast.error('Bill not generated',error.message);
                } finally {restore();}
                return;
            }

            const cancelBtn=event.target.closest('[data-cancel-appt]');
            if(cancelBtn && !cancelBtn.disabled) {
                const id=Number(cancelBtn.dataset.cancelAppt);
                const appointment=table.getRows().find(r=>r.appointment_id===id);
                if(!appointment) return;
                const confirmed=await MV.confirm({title:'Cancel appointment #'+id+'?',message:'Cancel visit for '+appointment.patient_name+' with '+appointment.doctor_name+' on '+MV.fmt.date(appointment.appointment_date)+'?',confirmText:'Cancel Appointment',kind:'danger'});
                if(!confirmed) return;
                const restore=MV.pending(cancelBtn,'Cancelling…');
                try {
                    await MV.api.post('/api/staff/receptionist/appointments/'+id+'/cancel',{});
                    MV.toast.success('Appointment #'+id+' cancelled');
                    await table.reload();
                } catch(error) {
                    MV.toast.error('Cancel failed',error.message);
                } finally {restore();}
                return;
            }

            const reschedBtn=event.target.closest('[data-reschedule-appt]');
            if(reschedBtn && !reschedBtn.disabled) {
                const id=Number(reschedBtn.dataset.rescheduleAppt);
                const appointment=table.getRows().find(r=>r.appointment_id===id);
                if(!appointment) return;
                container.querySelector('#reschedApptId').value = id;
                container.querySelector('#reschedSummary').value = appointment.patient_name + ' · ' + appointment.doctor_name;
                container.querySelector('#reschedDate').value = String(appointment.appointment_date || '').slice(0, 10);
                container.querySelector('#reschedTime').value = String(appointment.appointment_time || '').slice(0, 5);
                if (reschedModal) reschedModal.show();
            }
        });

        const confirmReschedBtn = container.querySelector('#confirmRescheduleBtn');
        if (confirmReschedBtn) {
            confirmReschedBtn.addEventListener('click', async function () {
                const form = container.querySelector('#rescheduleApptForm');
                if (!form.checkValidity()) return form.reportValidity();
                const id = Number(container.querySelector('#reschedApptId').value);
                const appointment_date = container.querySelector('#reschedDate').value;
                let appointment_time = container.querySelector('#reschedTime').value;
                if (appointment_time && appointment_time.length === 5) appointment_time += ':00';
                const restore = MV.pending(confirmReschedBtn, 'Saving…');
                try {
                    await MV.api.post('/api/staff/receptionist/appointments/' + id + '/reschedule', {
                        appointment_date,
                        appointment_time
                    });
                    MV.toast.success('Appointment rescheduled');
                    if (reschedModal) reschedModal.hide();
                    await table.reload();
                } catch (error) {
                    MV.toast.error('Reschedule failed', error.message);
                } finally {
                    restore();
                }
            });
        }
    };
})();
