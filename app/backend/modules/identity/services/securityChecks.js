const { normalizeSettings } = require('../../../common/settings');

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

function collectSecurityPolicyIssues(securityInfo, settings) {
  const issues = [];
  if (!securityInfo) {
    issues.push('Missing securityInfo');
    return issues;
  }

  const cfg = normalizeSettings(settings);
  const os = normalizeOs(securityInfo.os);
  if (!os) {
    issues.push('Missing or invalid OS in securityInfo');
    return issues;
  }

  if (cfg.enforceKernelCheck) {
    const minRaw = os === 'linux' ? cfg.minKernelVersionLinux : cfg.minKernelVersionWindows;
    if (securityInfo.rawKernel != null && minRaw != null) {
      const clientVer = parseKernelSemver(securityInfo.rawKernel);
      const minVer = parseKernelSemver(String(minRaw));
      if (cmpKernelSemver(clientVer, minVer) <= 0) {
        issues.push(
          `${os} version ${securityInfo.rawKernel} is too old (must be > ${minRaw})`
        );
      }
    }
  }

  const enforceFirewall = os === 'linux' ? cfg.enforceFirewallLinux : cfg.enforceFirewallWindows;
  if (enforceFirewall && securityInfo.firewallActive !== true) {
    issues.push(`Firewall is not enabled (${os})`);
  }

  const enforcePassword = os === 'linux'
    ? cfg.enforcePasswordRequiredLinux
    : cfg.enforcePasswordRequiredWindows;
  if (enforcePassword && hasPasswordlessShellUsers(securityInfo)) {
    issues.push(
      `Passwordless login user(s): ${securityInfo.passwordlessShellUsers.join(', ')}`
    );
  }

  if (os === 'linux') {
    if (cfg.enforceWifiSecureLinux && securityInfo.wifiInsecure === true) {
      issues.push('Insecure Wi-Fi (weak cipher or open authentication)');
    }
    if (cfg.enforceNoUnallowedSharesLinux) {
      const shares = Array.isArray(securityInfo.unallowedShares) ? securityInfo.unallowedShares : [];
      if (shares.length > 0) {
        issues.push('Disallowed SMB shares');
      }
    }
    if (cfg.enforceNoMobileHotspotLinux && securityInfo.mobileHotspotActive === true) {
      issues.push('Mobile hotspot is active');
    }
    if (cfg.enforceNoUsbStorageLinux && securityInfo.usbStoragePresent === true) {
      issues.push('External USB storage is connected');
    }
  }

  if (os === 'windows') {
    if (cfg.enforceWifiSecureWindows && securityInfo.wifiInsecure === true) {
      issues.push('Insecure Wi-Fi (weak cipher or open authentication)');
    }
    if (cfg.enforceNoUnallowedSharesWindows) {
      const shares = Array.isArray(securityInfo.unallowedShares) ? securityInfo.unallowedShares : [];
      if (shares.length > 0) {
        issues.push('Disallowed SMB shares');
      }
    }
    if (cfg.enforceNoMobileHotspotWindows && securityInfo.mobileHotspotActive === true) {
      issues.push('Mobile hotspot (Wi-Fi Direct) is active');
    }
    if (cfg.enforceNoUsbStorageWindows && securityInfo.usbStoragePresent === true) {
      issues.push('External USB storage is connected');
    }
    if (cfg.enforceAntivirusWindows) {
      if (securityInfo.antivirusEnabled !== true || securityInfo.realTimeProtectionEnabled !== true) {
        issues.push('Antivirus or real-time protection is not enabled');
      }
    }
    if (cfg.enforceUacWindows && securityInfo.uacEnabled !== true) {
      issues.push('UAC is not enabled');
    }
    if (cfg.enforceBitlockerWindows && securityInfo.bitlockerCompliant !== true) {
      issues.push('BitLocker is not fully enabled on all mounted volumes');
    }
  }

  return issues;
}

function formatIssues(issues) {
  return Array.isArray(issues) && issues.length > 0 ? issues.join('; ') : '';
}

module.exports = {
  parseKernelSemver,
  cmpKernelSemver,
  collectSecurityPolicyIssues,
  formatIssues
};
