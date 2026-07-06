package main

import (
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const clientOS = "linux"

var (
	iptablesPolicyRe = regexp.MustCompile(`(?i)\(policy\s+(\w+)\)`)
	allowedSMBShares = map[string]bool{
		"print$": true,
		"ipc$":   true,
	}
)

type SecurityInfo struct {
	OS                     string   `json:"os"`
	RawKernel              string   `json:"rawKernel"`
	KernelVersion          int      `json:"kernelVersion,omitempty"`
	FirewallActive         bool     `json:"firewallActive"`
	PasswordlessShellUsers []string `json:"passwordlessShellUsers,omitempty"`
	WifiInsecure           bool     `json:"wifiInsecure"`
	UnallowedShares        []string `json:"unallowedShares,omitempty"`
	MobileHotspotActive    bool     `json:"mobileHotspotActive"`
	UsbStoragePresent      bool     `json:"usbStoragePresent"`
}

func getSecurityInfo() SecurityInfo {
	info := SecurityInfo{OS: clientOS}

	if out, err := exec.Command("uname", "-r").Output(); err == nil {
		raw := strings.TrimSpace(string(out))
		info.RawKernel = raw
		if parts := strings.Split(raw, "."); len(parts) > 0 {
			if v, err := strconv.Atoi(parts[0]); err == nil {
				info.KernelVersion = v
			}
		}
	}

	policies := getFirewallPolicies()
	info.FirewallActive = isFirewallDropOnAllChains(policies)
	info.PasswordlessShellUsers = getPasswordlessShellUsers()
	info.WifiInsecure = linuxWifiInsecure()
	info.UnallowedShares = linuxUnallowedShares()
	info.MobileHotspotActive = linuxMobileHotspotActive()
	info.UsbStoragePresent = linuxUsbStoragePresent()

	return info
}

func getFirewallPolicies() map[string]string {
	policies := make(map[string]string)
	for _, chain := range []string{"INPUT", "OUTPUT", "FORWARD"} {
		if p := iptablesChainPolicy(chain); p != "" {
			policies[chain] = p
		}
	}
	return policies
}

func iptablesChainPolicy(chain string) string {
	out, err := exec.Command("iptables", "-L", chain, "-n").CombinedOutput()
	if err != nil {
		return ""
	}
	if m := iptablesPolicyRe.FindStringSubmatch(string(out)); len(m) > 1 {
		return strings.ToUpper(m[1])
	}
	return ""
}

func isFirewallDropOnAllChains(policies map[string]string) bool {
	if len(policies) == 0 {
		return false
	}
	for _, chain := range []string{"INPUT", "OUTPUT", "FORWARD"} {
		if strings.ToUpper(policies[chain]) != "DROP" {
			return false
		}
	}
	return true
}

func getPasswordlessShellUsers() []string {
	username := strings.TrimSpace(os.Getenv("SUDO_USER"))
	if username == "" {
		username = strings.TrimSpace(os.Getenv("LOGNAME"))
	}
	if username == "" || username == "root" {
		return nil
	}

	out, err := exec.Command("getent", "passwd", username).Output()
	if err != nil {
		return nil
	}
	fields := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(fields) < 7 {
		return nil
	}
	shell := fields[6]
	if strings.Contains(shell, "nologin") || strings.Contains(shell, "false") {
		return nil
	}

	out, err = exec.Command("getent", "shadow", username).Output()
	if err != nil {
		return nil
	}
	shadowFields := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(shadowFields) >= 2 && shadowFields[1] == "" {
		return []string{username}
	}
	return nil
}

func isAllowedWifiSecurity(sec string) bool {
	sec = strings.ToUpper(strings.TrimSpace(sec))
	if sec == "" || sec == "--" {
		return false
	}
	for _, ok := range []string{"WPA", "WPA2", "WPA3"} {
		if strings.Contains(sec, ok) {
			return true
		}
	}
	return false
}

func linuxWifiInsecure() bool {
	out, err := exec.Command("nmcli", "-t", "-f", "IN-USE,SECURITY", "dev", "wifi", "list").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) != "*" {
			continue
		}
		return !isAllowedWifiSecurity(parts[1])
	}
	return false
}

func linuxMobileHotspotActive() bool {
	if out, err := exec.Command("nmcli", "-t", "-f", "NAME", "connection", "show", "--active").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			if strings.EqualFold(strings.TrimSpace(line), "Hotspot") {
				return true
			}
		}
	}

	if out, err := exec.Command("iw", "dev").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			if strings.TrimSpace(line) == "type AP" {
				return true
			}
		}
	}

	if out, err := exec.Command("systemctl", "is-active", "hostapd").Output(); err == nil {
		if strings.TrimSpace(string(out)) == "active" {
			return true
		}
	}
	return false
}

func linuxUsbStoragePresent() bool {
	out, err := exec.Command("lsblk", "-o", "NAME,RM,TRAN,TYPE", "-n").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 3 {
			continue
		}
		devType := fields[len(fields)-1]
		if devType == "loop" {
			continue
		}
		rm := fields[1]
		tran := ""
		if len(fields) >= 4 {
			tran = strings.ToLower(fields[2])
		}
		if rm == "1" || tran == "usb" {
			return true
		}
	}
	return false
}

func linuxUnallowedShares() []string {
	var bad []string

	if out, err := exec.Command("showmount", "-e", "127.0.0.1").Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "Export list") {
				continue
			}
			bad = append(bad, "nfs:"+line)
		}
	}

	for _, unit := range []string{"samba", "smbd"} {
		if out, err := exec.Command("systemctl", "is-active", unit).Output(); err == nil {
			if strings.TrimSpace(string(out)) == "active" {
				bad = append(bad, unit)
				break
			}
		}
	}

	if out, err := exec.Command("smbclient", "-L", "localhost", "-N").CombinedOutput(); err == nil {
		inShares := false
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "Sharename") {
				inShares = true
				continue
			}
			if !inShares || line == "" || strings.HasPrefix(line, "---") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			if fields[1] != "Disk" && fields[1] != "IPC" {
				continue
			}
			name := strings.ToLower(fields[0])
			if allowedSMBShares[name] {
				continue
			}
			bad = append(bad, fields[0])
		}
	}

	sort.Strings(bad)
	return bad
}
