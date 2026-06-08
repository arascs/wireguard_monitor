function wireSecretToggles() {
  document.querySelectorAll('.btn-toggle-secret').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-target');
      const input = id ? document.getElementById(id) : null;
      if (!input) return;
      const plain = input.type === 'password';
      input.type = plain ? 'text' : 'password';
      btn.setAttribute('aria-pressed', plain ? 'true' : 'false');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settings-form');
  const btn = document.getElementById('save-settings-btn');
  wireSecretToggles();

  fetch('/api/settings', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then((data) => {
      if (data.success && data.settings) {
        const s = data.settings;
        document.getElementById('peerDisableHours').value = s.peerDisableHours;
        document.getElementById('physicalInterface').value = s.physicalInterface || '';
        document.getElementById('nodeApiKey').value = s.apiKey || '';
        document.getElementById('enforceKernelCheck').checked = s.enforceKernelCheck !== false;
        document.getElementById('minKernelVersionLinux').value =
          s.minKernelVersionLinux !== undefined ? s.minKernelVersionLinux : 4;
        document.getElementById('minKernelVersionWindows').value =
          s.minKernelVersionWindows !== undefined ? s.minKernelVersionWindows : 10;
        document.getElementById('enforceFirewallLinux').checked = s.enforceFirewallLinux !== false;
        document.getElementById('enforceFirewallWindows').checked = s.enforceFirewallWindows !== false;
        document.getElementById('enforcePasswordRequiredLinux').checked =
          s.enforcePasswordRequiredLinux !== false;
        document.getElementById('enforcePasswordRequiredWindows').checked =
          s.enforcePasswordRequiredWindows !== false;
      } else {
        alert('Failed to load settings: ' + (data.error || 'Unknown error'));
      }
    })
    .catch((err) => alert('Error fetching settings: ' + err.message));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const payload = {
      peerDisableHours: document.getElementById('peerDisableHours').value,
      physicalInterface: document.getElementById('physicalInterface').value.trim(),
      apiKey: document.getElementById('nodeApiKey').value,
      enforceKernelCheck: document.getElementById('enforceKernelCheck').checked,
      minKernelVersionLinux: document.getElementById('minKernelVersionLinux').value,
      minKernelVersionWindows: document.getElementById('minKernelVersionWindows').value,
      enforceFirewallLinux: document.getElementById('enforceFirewallLinux').checked,
      enforceFirewallWindows: document.getElementById('enforceFirewallWindows').checked,
      enforcePasswordRequiredLinux: document.getElementById('enforcePasswordRequiredLinux').checked,
      enforcePasswordRequiredWindows: document.getElementById('enforcePasswordRequiredWindows').checked
    };

    fetch('/api/settings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          alert('Settings saved successfully!');
        } else {
          alert('Failed to save settings: ' + (data.error || 'Unknown error'));
        }
      })
      .catch((err) => alert('Error saving settings: ' + err.message))
      .finally(() => {
        btn.disabled = false;
        btn.textContent = 'Save Settings';
      });
  });
});
