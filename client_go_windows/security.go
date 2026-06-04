package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const clientOS = "windows"

type SecurityInfo struct {
	OS                     string   `json:"os"`
	RawKernel              string   `json:"rawKernel"`
	KernelVersion          int      `json:"kernelVersion,omitempty"`
	FirewallActive         bool     `json:"firewallActive"`
	PasswordlessShellUsers []string `json:"passwordlessShellUsers,omitempty"`
}

func getSecurityInfo() SecurityInfo {
	info := SecurityInfo{OS: clientOS}
	info.RawKernel, info.KernelVersion = windowsOSVersion()
	info.FirewallActive = windowsFirewallEnabled()
	info.PasswordlessShellUsers = windowsCurrentUserPasswordless()
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
