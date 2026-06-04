package main

import (
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const clientOS = "linux"

type SecurityInfo struct {
	OS                     string   `json:"os"`
	RawKernel              string   `json:"rawKernel"`
	KernelVersion          int      `json:"kernelVersion,omitempty"`
	FirewallActive         bool     `json:"firewallActive"`
	PasswordlessShellUsers []string `json:"passwordlessShellUsers,omitempty"`
}

var iptablesPolicyRe = regexp.MustCompile(`(?i)\(policy\s+(\w+)\)`)

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
	awkScript := `FNR==NR { shadow[$1]=$2; next } $7 !~ /(nologin|false)$/ { if (shadow[$1] == "") print $1 }`
	out, err := exec.Command("sudo", "awk", "-F:", awkScript, "/etc/shadow", "/etc/passwd").Output()
	if err != nil {
		return nil
	}
	var users []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			users = append(users, line)
		}
	}
	sort.Strings(users)
	return users
}
