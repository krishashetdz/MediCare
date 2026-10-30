(function () {
    MV.receptionBilling = function (container) {
        container.innerHTML = '<section class="mv-card"><div class="mv-card-head"><h2>Appointments & billing</h2><a class="mv-btn mv-btn-outline" href="/billing.html" data-testid="reception-all-bills">Billing ledger</a></div><div id="receptionAppointments"></div><div id="billResult" role="status" aria-live="polite" data-testid="reception-bill-result"></div></section>';
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
            rowActions:r=>r.bill_id
                ? '<a class="mv-btn mv-btn-outline mv-btn-sm" data-testid="appointment-'+r.appointment_id+'-view-bill" href="/billing.html?id='+r.bill_id+'">View bill #'+r.bill_id+'</a>'
                : r.consultation_id
                ? '<button class="mv-btn mv-btn-primary mv-btn-sm" data-generate-bill="'+r.appointment_id+'" data-testid="appointment-'+r.appointment_id+'-generate-bill">'+MV.icon('file-invoice')+'Generate Bill</button>'
                : '<span class="text-muted" data-testid="appointment-'+r.appointment_id+'-billing-pending">Awaiting consultation</span>',
            empty:{title:'No appointments',text:'No visits on record.'}
        });
        container.addEventListener('click',async event=>{
            const button=event.target.closest('[data-generate-bill]');
            if(!button || button.disabled) return;
            const id=Number(button.dataset.generateBill);
            const appointment=table.getRows().find(r=>r.appointment_id===id);
            if(!appointment) return;
            const confirmed=await MV.confirm({title:'Generate bill for '+appointment.patient_name+'?',message:'Visit #'+id+' · '+MV.fmt.date(appointment.appointment_date)+'. Charges will include the recorded consultation, lab tests and prescribed medicines.',confirmText:'Generate Bill',kind:'primary'});
            if(!confirmed) return;
            const restore=MV.pending(button,'Generating…');
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
        });
    };
})();