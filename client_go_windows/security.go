package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const clientOS = "windows"

var allowedAdminShares = map[string]bool{
	"ADMIN$": true,
	"C$":     true,
	"D$":     true,
	"IPC$":   true,
}

type SecurityInfo struct {
	OS                        string   `json:"os"`
	RawKernel                 string   `json:"rawKernel"`
	KernelVersion             int      `json:"kernelVersion,omitempty"`
	FirewallActive            bool     `json:"firewallActive"`
	PasswordlessShellUsers    []string `json:"passwordlessShellUsers,omitempty"`
	WifiInsecure              bool     `json:"wifiInsecure"`
	UnallowedShares           []string `json:"unallowedShares,omitempty"`
	MobileHotspotActive       bool     `json:"mobileHotspotActive"`
	UsbStoragePresent         bool     `json:"usbStoragePresent"`
	AntivirusEnabled          bool     `json:"antivirusEnabled"`
	RealTimeProtectionEnabled bool     `json:"realTimeProtectionEnabled"`
	UacEnabled                bool     `json:"uacEnabled"`
	BitlockerCompliant        bool     `json:"bitlockerCompliant"`
}

func getSecurityInfo() SecurityInfo {
	info := SecurityInfo{OS: clientOS}
	info.RawKernel, info.KernelVersion = windowsOSVersion()
	info.FirewallActive = windowsFirewallEnabled()
	info.PasswordlessShellUsers = windowsCurrentUserPasswordless()
	info.WifiInsecure = windowsWifiInsecure()
	info.UnallowedShares = windowsUnallowedShares()
	info.MobileHotspotActive = windowsMobileHotspotActive()
	info.UsbStoragePresent = windowsUsbStoragePresent()
	info.AntivirusEnabled, info.RealTimeProtectionEnabled = windowsDefenderStatus()
	info.UacEnabled = windowsUacEnabled()
	info.BitlockerCompliant = windowsBitlockerCompliant()
	return info
}

func windowsOSVersion() (raw string, major int) {
	out, err := exec.Command("wmic", "os", "get", "Version", "/value").Output()
	if err != nil {
		return "", 0
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(strings.ToLower(line), "version=") {
			continue
		}
		raw = strings.TrimSpace(strings.TrimPrefix(line, "Version="))
		if parts := strings.Split(raw, "."); len(parts) > 0 {
			major, _ = strconv.Atoi(parts[0])
		}
		break
	}
	return raw, major
}

func windowsFirewallEnabled() bool {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"$p = Get-NetFirewallProfile | Select-Object Name, Enabled; ($p.Count -ge 3) -and (($p | Where-Object { $_.Enabled -ne $true }).Count -eq 0)",
	).Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "True"
}

func windowsCurrentUserPasswordless() []string {
	username := strings.TrimSpace(os.Getenv("USERNAME"))
	if username == "" {
		return nil
	}
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PasswordRequired",
	).Output()
	if err != nil {
		return nil
	}
	if strings.EqualFold(strings.TrimSpace(string(out)), "False") {
		return []string{username}
	}
	return nil
}

func windowsWifiInsecure() bool {
	out, err := exec.Command("netsh", "wlan", "show", "interfaces").Output()
	if err != nil {
		return false
	}
	text := strings.ToLower(string(out))
	if strings.Contains(text, "there is no wireless interface") {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		lower := strings.ToLower(line)
		idx := strings.Index(lower, ":")
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(lower[:idx])
		val := strings.TrimSpace(lower[idx+1:])
		if key == "cipher" && (val == "wep" || val == "tkip" || val == "none") {
			return true
		}
		if key == "authentication" && (val == "open" || val == "wep") {
			return true
		}
	}
	return false
}

func windowsUnallowedShares() []string {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"Get-SmbShare -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name",
	).Output()
	if err != nil {
		return nil
	}
	var bad []string
	for _, line := range strings.Split(string(out), "\n") {
		name := strings.TrimSpace(line)
		if name == "" || allowedAdminShares[name] {
			continue
		}
		bad = append(bad, name)
	}
	return bad
}

func windowsMobileHotspotActive() bool {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Wi-Fi Direct' }).Count",
	).Output()
	if err != nil {
		return false
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n > 0
}

func windowsUsbStoragePresent() bool {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-Disk -ErrorAction SilentlyContinue | Where-Object { $_.BusType -eq 'USB' }).Count",
	).Output()
	if err != nil {
		return false
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n > 0
}

func windowsDefenderStatus() (antivirusEnabled, realTimeEnabled bool) {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"$s = Get-MpComputerStatus -ErrorAction SilentlyContinue; if ($null -eq $s) { 'False False' } else { \"$($s.AntivirusEnabled) $($s.RealTimeProtectionEnabled)\" }",
	).Output()
	if err != nil {
		return false, false
	}
	parts := strings.Fields(strings.TrimSpace(string(out)))
	if len(parts) < 2 {
		return false, false
	}
	return strings.EqualFold(parts[0], "True"), strings.EqualFold(parts[1], "True")
}

func windowsUacEnabled() bool {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue).EnableLUA",
	).Output()
	if err != nil {
		return false
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	return err == nil && n == 1
}

func windowsBitlockerCompliant() bool {
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		`$vols = Get-BitLockerVolume -ErrorAction SilentlyContinue | Where-Object { $_.MountPoint -and $_.MountPoint -ne '' }; if (-not $vols) { 'False' } else { $bad = $vols | Where-Object { $_.VolumeStatus -ne 'FullyEncrypted' -or $_.ProtectionStatus -ne 'On' }; if ($bad) { 'False' } else { 'True' } }`,
	).Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "True"
}
