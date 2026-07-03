let pendingEnableRuleId = null;

async function loadSitesForRules() {
  const select = document.getElementById('rule-site-id');
  if (!select) return;
  select.innerHTML = '';
  try {
    const res = await fetch('/api/sites');
    const data = await res.json();
    if (!data.success) return;
    (data.sites || []).forEach((site) => {
      const opt = document.createElement('option');
      opt.value = site.id;
      opt.textContent = site.site_name || `#${site.id}`;
      select.appendChild(opt);
    });
  } catch (e) { /* ignore */ }
}

async function loadDevicesForRules() {
  const select = document.getElementById('rule-device-id');
  if (!select) return;
  select.innerHTML = '';
  try {
    const res = await fetch('/api/devices');
    const data = await res.json();
    if (!data.success) return;
    (data.devices || []).forEach((dev) => {
      const opt = document.createElement('option');
      opt.value = dev.id;
      opt.textContent = `${dev.device_name} (${dev.username})`;
      select.appendChild(opt);
    });
  } catch (e) { /* ignore */ }
}

async function loadInterfacesForRules() {
  const select = document.getElementById('rule-interface-name');
  if (!select) return;
  select.innerHTML = '';
  try {
    const res = await fetch('/api/interfaces');
    const data = await res.json();
    const ifaces = Array.isArray(data) ? data : (data.interfaces || []);
    ifaces.forEach((iface) => {
      const opt = document.createElement('option');
      const name = typeof iface === 'string' ? iface : iface.name;
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  } catch (e) { /* ignore */ }
}

async function loadApplicationsForRules() {
  const select = document.getElementById('rule-application-id');
  if (!select) return;
  select.innerHTML = '';
  try {
    const res = await fetch('/api/applications');
    const data = await res.json();
    if (!data.success) return;
    (data.applications || []).forEach((app) => {
      const opt = document.createElement('option');
      opt.value = app.id;
      opt.textContent = app.name;
      select.appendChild(opt);
    });
  } catch (e) { /* ignore */ }
}

function openEnableRuleModal(ruleId) {
  pendingEnableRuleId = ruleId;
  document.getElementById('enable-rule-modal')?.classList.add('open');
}

function closeEnableRuleModal() {
  pendingEnableRuleId = null;
  document.getElementById('enable-rule-modal')?.classList.remove('open');
}

async function enableRule(position) {
  const id = pendingEnableRuleId;
  if (!id) return;
  closeEnableRuleModal();
  const res = await fetch(`/api/access-rules/${id}/enable`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position })
  });
  const data = await res.json();
  if (data.success) {
    loadAccessRules();
  } else {
    alert(data.error || 'Cannot enable rule');
  }
}

async function loadAccessRules() {
  const tbody = document.getElementById('rules-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  try {
    const res = await fetch('/api/access-rules');
    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Cannot load access rules');
      return;
    }
    (data.rules || []).forEach((rule) => {
      const tr = document.createElement('tr');
      const statusText = rule.status === 1 ? 'On' : 'Off';
      const btnLabel = rule.status === 1 ? 'Disable' : 'Enable';
      const expireText = rule.expire_label || 'Never';
      tr.innerHTML = `
        <td>${rule.name}</td>
        <td>${rule.source_label}</td>
        <td>${rule.application_name || ''}</td>
        <td>${rule.action}</td>
        <td>${expireText}</td>
        <td>${statusText}</td>
        <td><button data-id="${rule.id}" class="toggle-rule-btn">${btnLabel}</button></td>
        <td><button data-id="${rule.id}" class="delete-rule-btn btn btn-danger" title="Delete Rule"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg></button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('.toggle-rule-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const row = (data.rules || []).find((r) => String(r.id) === String(id));
        if (!row) return;
        if (row.status === 1) {
          const res2 = await fetch(`/api/access-rules/${id}/disable`, { method: 'POST' });
          const d2 = await res2.json();
          if (d2.success) loadAccessRules();
          else alert(d2.error || 'Cannot disable rule');
        } else {
          openEnableRuleModal(id);
        }
      });
    });
    tbody.querySelectorAll('.delete-rule-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Are you sure you want to delete this access rule? This action cannot be undone.')) return;
        const res2 = await fetch(`/api/access-rules/${id}`, { method: 'DELETE' });
        const d2 = await res2.json();
        if (d2.success) loadAccessRules();
        else alert(d2.error || 'Cannot delete rule');
      });
    });
  } catch (e) {
    alert(e.message || 'Error loading access rules');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const sourceTypeSelect = document.getElementById('rule-source-type');
  const siteGroup = document.getElementById('rule-source-site-group');
  const deviceGroup = document.getElementById('rule-source-device-group');
  const interfaceGroup = document.getElementById('rule-source-interface-group');
  const form = document.getElementById('create-rule-form');
  const setExpireCb = document.getElementById('rule-set-expire');
  const expireHoursRow = document.getElementById('rule-expire-hours-row');

  function updateSourceGroups(v) {
    const hideAll = v === 'all';
    siteGroup.style.display = v === 'site' ? 'block' : 'none';
    deviceGroup.style.display = v === 'device' ? 'block' : 'none';
    interfaceGroup.style.display = v === 'interface' ? 'block' : 'none';
    if (hideAll) {
      siteGroup.style.display = 'none';
      deviceGroup.style.display = 'none';
      interfaceGroup.style.display = 'none';
    }
  }

  function openCreateRuleModal() {
    form?.reset();
    if (sourceTypeSelect) sourceTypeSelect.value = 'all';
    updateSourceGroups('all');
    expireHoursRow?.classList.remove('open');
    document.getElementById('create-rule-modal')?.classList.add('open');
  }

  function closeCreateRuleModal() {
    document.getElementById('create-rule-modal')?.classList.remove('open');
  }

  setExpireCb?.addEventListener('change', () => {
    expireHoursRow?.classList.toggle('open', setExpireCb.checked);
  });

  if (sourceTypeSelect) {
    sourceTypeSelect.addEventListener('change', () => updateSourceGroups(sourceTypeSelect.value));
    updateSourceGroups(sourceTypeSelect.value);
  }

  loadSitesForRules();
  loadDevicesForRules();
  loadInterfacesForRules();
  loadApplicationsForRules();
  loadAccessRules();

  document.getElementById('btn-add-rule')?.addEventListener('click', openCreateRuleModal);
  document.getElementById('create-rule-cancel')?.addEventListener('click', closeCreateRuleModal);
  document.getElementById('create-rule-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'create-rule-modal') closeCreateRuleModal();
  });

  document.getElementById('enable-rule-first')?.addEventListener('click', () => enableRule('first'));
  document.getElementById('enable-rule-last')?.addEventListener('click', () => enableRule('last'));
  document.getElementById('enable-rule-cancel')?.addEventListener('click', closeEnableRuleModal);
  document.getElementById('enable-rule-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'enable-rule-modal') closeEnableRuleModal();
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('rule-name').value.trim();
      const sourceType = document.getElementById('rule-source-type').value;
      const applicationId = document.getElementById('rule-application-id').value;
      const action = document.getElementById('rule-action').value;

      if (!name || !sourceType || !applicationId || !action) return;

      const body = {
        name,
        sourceType,
        applicationId: parseInt(applicationId, 10),
        action
      };

      if (setExpireCb?.checked) {
        const hours = parseInt(document.getElementById('rule-expire-hours').value, 10);
        if (!Number.isFinite(hours) || hours < 1) {
          alert('Enter valid expiration hours');
          return;
        }
        body.expireHours = hours;
      }

      if (sourceType === 'site') {
        const siteId = document.getElementById('rule-site-id').value;
        if (!siteId) return;
        body.sourceSiteId = parseInt(siteId, 10);
      } else if (sourceType === 'device') {
        const deviceId = document.getElementById('rule-device-id').value;
        if (!deviceId) return;
        body.sourceDeviceId = parseInt(deviceId, 10);
      } else if (sourceType === 'interface') {
        const iface = document.getElementById('rule-interface-name').value;
        if (!iface) return;
        body.sourceInterface = iface;
      }

      const res = await fetch('/api/access-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.success) {
        closeCreateRuleModal();
        loadAccessRules();
      } else {
        alert(data.error || 'Cannot create access rule');
      }
    });
  }
});
