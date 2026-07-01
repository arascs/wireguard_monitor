document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settings-form');
  const btn = document.getElementById('save-settings-btn');

  fetch('/api/settings', { credentials: 'same-origin' })
    .then((res) => res.json())
    .then((data) => {
      if (data.success && data.settings) {
        const s = data.settings;
        document.getElementById('peerDisableHours').value = s.peerDisableHours;
        document.getElementById('keyRotationTimeoutSeconds').value =
          s.keyRotationTimeoutSeconds !== undefined ? s.keyRotationTimeoutSeconds : 60;
        document.getElementById('physicalInterface').value = s.physicalInterface || '';
        document.getElementById('centralUrl').value = s.centralUrl || '';
        document.getElementById('metricsPushIntervalMs').value =
          s.metricsPushIntervalMs !== undefined ? s.metricsPushIntervalMs : 30000;
        document.getElementById('allowedLanRanges').value = s.allowedLanRanges || '192.168.220.0/24';
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
      keyRotationTimeoutSeconds: document.getElementById('keyRotationTimeoutSeconds').value,
      physicalInterface: document.getElementById('physicalInterface').value.trim(),
      centralUrl: document.getElementById('centralUrl').value.trim(),
      metricsPushIntervalMs: document.getElementById('metricsPushIntervalMs').value,
      allowedLanRanges: document.getElementById('allowedLanRanges').value.trim()
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
