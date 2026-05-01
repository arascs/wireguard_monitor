package main

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// SecurityInfo matches the structure expected by the server's /device-heartbeat API
type SecurityInfo struct {
	KernelVersion  int    `json:"kernelVersion"`
	RawKernel      string `json:"rawKernel"`
	SSHRootLogin   bool   `json:"sshRootLogin"`
	FirewallActive bool   `json:"firewallActive"`
}

func getSecurityInfo() SecurityInfo {
	info := SecurityInfo{}

	// 1. Kernel version via uname -r
	if out, err := exec.Command("uname", "-r").Output(); err == nil {
		raw := strings.TrimSpace(string(out))
		info.RawKernel = raw
		parts := strings.Split(raw, ".")
		if len(parts) > 0 {
			if v, err := strconv.Atoi(parts[0]); err == nil {
				info.KernelVersion = v
			}
		}
	}

	// 2. SSH PermitRootLogin yes
	if f, err := os.Open("/etc/ssh/sshd_config"); err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "#") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 &&
				strings.EqualFold(fields[0], "PermitRootLogin") &&
				strings.EqualFold(fields[1], "yes") {
				info.SSHRootLogin = true
				break
			}
		}
	}

	// 3. Firewall: try ufw first, fallback to iptables
	if _, err := exec.LookPath("ufw"); err == nil {
		if out, err := exec.Command("ufw", "status").Output(); err == nil {
			if !strings.Contains(strings.ToLower(string(out)), "status: inactive") {
				info.FirewallActive = true
			}
		}
	} else {
		if out, err := exec.Command("iptables", "-L", "INPUT").Output(); err == nil {
			if !strings.Contains(string(out), "Chain INPUT (policy ACCEPT)") {
				info.FirewallActive = true
			}
		}
	}

	return info
}
