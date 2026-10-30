/* Shared presentation semantics for the original dynamically-rendered pages. */
(function () {
    const slug = s => String(s || '').replace(/([a-z])([A-Z])/g,'$1-$2').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const page = slug(location.pathname.split('/').pop().replace('.html','') || 'login');
    const ids = new Map();
    let sequence = 0;
    const unique = value => { const n=(ids.get(value)||0)+1; ids.set(value,n); return value+(n>1?'-'+n:''); };
    function enrich(root) {
        if (!root.querySelectorAll) return;
        root.querySelectorAll('table').forEach(table => {
            const columns = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
            table.querySelectorAll('tbody tr').forEach(row => [...row.children].forEach((td,i) => {
                if (!td.dataset.label && columns[i]) td.dataset.label=columns[i];
            }));
        });
        root.querySelectorAll('label:not([for])').forEach(label => {
            const control=label.parentElement.querySelector('input:not([type=hidden]),select,textarea');
            if (control) { if (!control.id) control.id=page+'-field-'+(++sequence); label.htmlFor=control.id; }
        });
        root.querySelectorAll('input:not([type=hidden]),select,textarea').forEach(control => {
            if (control.labels?.length || control.hasAttribute('aria-label')) return;
            const td=control.closest('td');
            control.setAttribute('aria-label',td?.dataset.label || control.placeholder || control.name?.replace(/_/g,' ') || control.type);
        });
        root.querySelectorAll('.btn-close').forEach(el => el.setAttribute('aria-label','Close'));
        root.querySelectorAll('.modal').forEach(modal => {
            const title=modal.querySelector('.modal-title');
            if (title && !modal.hasAttribute('aria-labelledby')) { if(!title.id) title.id=page+'-dialog-title-'+(++sequence); modal.setAttribute('aria-labelledby',title.id); }
        });
        root.querySelectorAll('[onclick]:not(button):not(a), .bed-tile[role=button]').forEach(el => {
            el.setAttribute('role','button'); el.tabIndex=0;
            if(el.matches('.dept-card,.doctor-card,.calendar-day,.time-slot')) el.setAttribute('aria-pressed',el.classList.contains('selected')?'true':'false');
        });
        root.querySelectorAll('.wizard-step').forEach(step => {
            if(step.classList.contains('active')) step.setAttribute('aria-current','step'); else step.removeAttribute('aria-current');
        });
        root.querySelectorAll('.role-tab').forEach(tab => tab.setAttribute('aria-pressed',tab.classList.contains('active')?'true':'false'));
        root.querySelectorAll('button,a,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,p,th,td,label,small,span,dt,dd,article,[id],.mv-stat-value,.value,.name,.patient,.meta,.bed-number,.bed-patient,.bed-status,.mv-page-sub,.mv-stat-label,.mv-stat-note,.mv-toast-title,.mv-toast-text').forEach(el => {
            if (el.dataset.testid || el.matches('script,style,svg,path,i')) return;
            const parent=el.closest('form,.modal,article,tr,[data-bed-id],[data-rx-id]');
            const scope=parent?.id || parent?.dataset.bedId || parent?.dataset.rxId || '';
            const name=el.id || el.name || el.getAttribute('aria-label') || el.dataset.label || (el.matches('a,button,label,h1,h2,h3,h4,h5,h6')?el.textContent.trim().slice(0,55):'') || el.classList[0] || el.tagName;
            el.dataset.testid=unique(page+'-'+slug(scope?scope+'-'+name:name));
        });
    }
    function init() {
        document.body.dataset.screen=page;
        enrich(document.body);
        const observer=new MutationObserver(records => {
            observer.disconnect();
            if(records.some(r=>r.type==='childList'||r.attributeName==='class')) enrich(document.body);
            observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
        });
        observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
        document.addEventListener('keydown', e => {
            const el=e.target.closest('[role=button]:not(button):not(a)');
            if(el && (e.key==='Enter'||e.key===' ')){e.preventDefault();el.click();}
            if(el && ['ArrowRight','ArrowLeft','ArrowDown','ArrowUp'].includes(e.key)){
                const siblings=[...el.parentElement.children].filter(x=>x.matches('[role=button]'));
                if(siblings.length>1){e.preventDefault();const delta=['ArrowRight','ArrowDown'].includes(e.key)?1:-1;siblings[(siblings.indexOf(el)+delta+siblings.length)%siblings.length].focus();}
            }
        });
        let lastFocus;
        document.addEventListener('show.bs.modal',()=>{lastFocus=document.activeElement;});
        document.addEventListener('hidden.bs.modal',()=>{if(lastFocus?.isConnected)lastFocus.focus();});
    }
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();