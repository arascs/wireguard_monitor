document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('settings-form');
  const btn = document.getElementById('save-settings-btn');
  
  // Fetch and display
  fetch('/api/settings')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.settings) {
        document.getElementById('keyExpiryDays').value = data.settings.keyExpiryDays;
        document.getElementById('peerDisableHours').value = data.settings.peerDisableHours;
        document.getElementById('keyRenewalTime').value = data.settings.keyRenewalTime;
      } else {
        alert('Failed to load settings: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(err => {
      alert('Error fetching settings: ' + err.message);
    });

  // Save
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Saving...';
    
    const payload = {
      keyExpiryDays: document.getElementById('keyExpiryDays').value,
      peerDisableHours: document.getElementById('peerDisableHours').value,
      keyRenewalTime: document.getElementById('keyRenewalTime').value
    };

    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        alert('Settings saved successfully!');
      } else {
        alert('Failed to save settings: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(err => {
      alert('Error saving settings: ' + err.message);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Save Settings';
    });
  });
});
