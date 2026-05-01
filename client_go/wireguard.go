package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	wgConfigDir       = "/etc/wireguard/"
	wgClientIface     = "wg_client"
	wgPrivKeyPath     = "/etc/wireguard/wg_client.key"
	wgPubKeyPath      = "/etc/wireguard/wg_client.pub"
)

// runShell executes a command and returns combined output
func runShell(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	result := strings.TrimSpace(string(out))
	if err != nil {
		return "", fmt.Errorf("%s: %s", err.Error(), result)
	}
	return result, nil
}

// ensureClientKeypair generates or loads the WireGuard client keypair
func ensureClientKeypair() (privKey, pubKey string, err error) {
	if data, e := os.ReadFile(wgPrivKeyPath); e == nil {
		privKey = strings.TrimSpace(string(data))
	}
	if privKey == "" {
		privKey, err = runShell("wg", "genkey")
		if err != nil {
			return "", "", fmt.Errorf("wg genkey: %w", err)
		}
		if err = os.WriteFile(wgPrivKeyPath, []byte(privKey), 0600); err != nil {
			return "", "", err
		}
	}
	// Derive public key
	cmd := exec.Command("wg", "pubkey")
	cmd.Stdin = strings.NewReader(privKey + "\n")
	out, err := cmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("wg pubkey: %w", err)
	}
	pubKey = strings.TrimSpace(string(out))
	_ = os.WriteFile(wgPubKeyPath, []byte(pubKey), 0600)
	return privKey, pubKey, nil
}

// configureClientInterface writes wg_client.conf and brings up the interface
func configureClientInterface(allowedIPs, serverPubKey, serverEndpoint, serverAllowedIPs string) error {
	privData, err := os.ReadFile(wgPrivKeyPath)
	if err != nil {
		return fmt.Errorf("read private key: %w", err)
	}
	privKey := strings.TrimSpace(string(privData))

	cfg := fmt.Sprintf(`[Interface]
PrivateKey = %s
Address = %s
ListenPort = 51000

[Peer]
PublicKey = %s
AllowedIPs = %s
Endpoint = %s
PersistentKeepalive = 25
`, privKey, allowedIPs, serverPubKey, serverAllowedIPs, serverEndpoint)

	cfgPath := filepath.Join(wgConfigDir, wgClientIface+".conf")
	if err := os.WriteFile(cfgPath, []byte(cfg), 0600); err != nil {
		return err
	}

	// Bring down existing interface if running
	if out, _ := runShell("wg", "show", "interfaces"); strings.Contains(out, wgClientIface) {
		runShell("wg-quick", "down", wgClientIface) // ignore error
	}
	if _, err := runShell("wg-quick", "up", wgClientIface); err != nil {
		return fmt.Errorf("wg-quick up: %w", err)
	}
	return nil
}

// bringDownVPN brings down the wg_client interface
func bringDownVPN() {
	exec.Command("ip", "link", "delete", wgClientIface).Run()
}

// getConnectionStatusMap returns map["ip:port"] = isConnected based on wg handshake timestamps
func getConnectionStatusMap(servers []Server) map[string]bool {
	result := make(map[string]bool)
	out, err := runShell("wg", "show", wgClientIface, "dump")
	if err != nil || out == "" {
		return result
	}

	peerHandshakes := make(map[string]int64)
	for i, line := range strings.Split(out, "\n") {
		if i == 0 {
			continue // skip interface line
		}
		parts := strings.Fields(line)
		if len(parts) >= 5 {
			var ts int64
			fmt.Sscanf(parts[4], "%d", &ts)
			peerHandshakes[parts[0]] = ts
		}
	}

	now := time.Now().Unix()
	for _, s := range servers {
		key := fmt.Sprintf("%s:%d", s.IP, s.Port)
		if hs, ok := peerHandshakes[s.PublicKey]; ok && hs > 0 && (now-hs) <= 180 {
			result[key] = true
		}
	}
	return result
}

// getDeviceName returns the machine hostname
func getDeviceName() string {
	if data, err := os.ReadFile("/etc/hostname"); err == nil {
		return strings.TrimSpace(string(data))
	}
	name, _ := os.Hostname()
	return strings.TrimSpace(name)
}

// getMachineID returns the /etc/machine-id content
func getMachineID() string {
	if data, err := os.ReadFile("/etc/machine-id"); err == nil {
		return strings.TrimSpace(string(data))
	}
	return ""
}
