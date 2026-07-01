const SHARED_CHECKS = ['kernel', 'firewall', 'passwordRequired', 'wifiSecure', 'noUnallowedShares', 'noMobileHotspot', 'noUsbStorage'];
const WINDOWS_ONLY_CHECKS = ['antivirus', 'uac', 'bitlocker'];

const CHECK_LABELS = {
  kernel: 'Minimum OS version',
  firewall: 'Firewall enabled',
  passwordRequired: 'Password required for login users',
  wifiSecure: 'Secure Wi-Fi',
  noUnallowedShares: 'No disallowed SMB shares',
  noMobileHotspot: 'No mobile hotspot',
  noUsbStorage: 'No external USB storage',
  antivirus: 'Antivirus and real-time protection',
  uac: 'UAC enabled',
  bitlocker: 'BitLocker compliant'
};

function getChecksForOs(os) {
  const base = [...SHARED_CHECKS];
  if (os === 'windows') base.push(...WINDOWS_ONLY_CHECKS);
  return base;
}

function parseKernelSemver(raw) {
  const s = String(raw || '').split('-')[0];
  const parts = s.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function cmpKernelSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function normalizeOs(os) {
  const v = String(os || '').trim().toLowerCase();
  if (v === 'linux' || v === 'windows') return v;
  return '';
}

function hasPasswordlessShellUsers(info) {
  const users = info && info.passwordlessShellUsers;
  return Array.isArray(users) && users.length > 0;
}

function normalizeProfileChecks(checks) {
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return {};
  return checks;
}

function collectSecurityPolicyIssues(securityInfo, profile) {
  const issues = [];
  if (!securityInfo) {
    issues.push('Missing securityInfo');
    return issues;
  }

  const os = normalizeOs(securityInfo.os);
  if (!os) {
    issues.push('Missing or invalid OS in securityInfo');
    return issues;
  }

  const profileOs = normalizeOs(profile && profile.os_type);
  if (!profileOs) {
    issues.push('Invalid security profile');
    return issues;
  }
  if (os !== profileOs) {
    issues.push(`OS mismatch: device reported ${os}, profile requires ${profileOs}`);
    return issues;
  }

  const checks = normalizeProfileChecks(profile.checks);
  const enabled = Object.keys(checks);
  if (enabled.length === 0) return issues;

  if (checks.kernel != null) {
    const minRaw = checks.kernel;
    if (securityInfo.rawKernel != null && minRaw != null) {
      const clientVer = parseKernelSemver(securityInfo.rawKernel);
      const minVer = parseKernelSemver(String(minRaw));
      if (cmpKernelSemver(clientVer, minVer) <= 0) {
        issues.push(`${os} version ${securityInfo.rawKernel} is too old (must be > ${minRaw})`);
      }
    }
  }

  if (checks.firewall && securityInfo.firewallActive !== true) {
    issues.push(`Firewall is not enabled (${os})`);
  }

  if (checks.passwordRequired && hasPasswordlessShellUsers(securityInfo)) {
    issues.push(`Passwordless login user(s): ${securityInfo.passwordlessShellUsers.join(', ')}`);
  }

  if (checks.wifiSecure && securityInfo.wifiInsecure === true) {
    issues.push('Insecure Wi-Fi (weak cipher or open authentication)');
  }

  if (checks.noUnallowedShares) {
    const shares = Array.isArray(securityInfo.unallowedShares) ? securityInfo.unallowedShares : [];
    if (shares.length > 0) {
      issues.push('Disallowed SMB shares');
    }
  }

  if (checks.noMobileHotspot && securityInfo.mobileHotspotActive === true) {
    issues.push(os === 'windows' ? 'Mobile hotspot (Wi-Fi Direct) is active' : 'Mobile hotspot is active');
  }

  if (checks.noUsbStorage && securityInfo.usbStoragePresent === true) {
    issues.push('External USB storage is connected');
  }

  if (checks.antivirus) {
    if (securityInfo.antivirusEnabled !== true || securityInfo.realTimeProtectionEnabled !== true) {
      issues.push('Antivirus or real-time protection is not enabled');
    }
  }

  if (checks.uac && securityInfo.uacEnabled !== true) {
    issues.push('UAC is not enabled');
  }

  if (checks.bitlocker && securityInfo.bitlockerCompliant !== true) {
    issues.push('BitLocker is not fully enabled on all mounted volumes');
  }

  return issues;
}

function formatIssues(issues) {
  return Array.isArray(issues) && issues.length > 0 ? issues.join('; ') : '';
}

function validateProfileChecks(osType, checks) {
  const os = normalizeOs(osType);
  if (!os) return 'Invalid os_type';
  const normalized = normalizeProfileChecks(checks);
  const allowed = new Set(getChecksForOs(os));
  for (const key of Object.keys(normalized)) {
    if (!allowed.has(key)) return `Invalid check for ${os}: ${key}`;
    if (key === 'kernel') {
      const v = parseInt(normalized.kernel, 10);
      if (!Number.isFinite(v) || v < 1) return 'kernel requires a positive version number';
    } else if (normalized[key] !== true) {
      return `Check ${key} must be true`;
    }
  }
  return null;
}

module.exports = {
  SHARED_CHECKS,
  WINDOWS_ONLY_CHECKS,
  CHECK_LABELS,
  getChecksForOs,
  parseKernelSemver,
  cmpKernelSemver,
  collectSecurityPolicyIssues,
  formatIssues,
  validateProfileChecks,
  normalizeProfileChecks
};
