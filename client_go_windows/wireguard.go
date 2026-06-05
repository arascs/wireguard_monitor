package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const wgClientIface = "wg_client"

func appDataDir() string {
	ex, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Join(filepath.Dir(ex), "wireguard")
}

func wgPrivKeyPath() string  { return filepath.Join(appDataDir(), "wg_client.key") }
func wgPubKeyPath() string   { return filepath.Join(appDataDir(), "wg_client.pub") }
func wgConfPath() string     { return filepath.Join(appDataDir(), wgClientIface+".conf") }

func findWGTool(name string) (string, error) {
	for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
		if base == "" {
			continue
		}
		p := filepath.Join(base, "WireGuard", name)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("%s not found (install WireGuard for Windows)", name)
}

func runWGTool(name string, args ...string) (string, error) {
	bin, err := findWGTool(name)
	if err != nil {
		return "", err
	}
	out, err := exec.Command(bin, args...).CombinedOutput()
	result := strings.TrimSpace(string(out))
	if err != nil {
		return result, fmt.Errorf("%s: %s", err, result)
	}
	return result, nil
}

func ensureClientKeypair() (privKey, pubKey string, err error) {
	if err = os.MkdirAll(appDataDir(), 0700); err != nil {
		return "", "", err
	}
	if data, e := os.ReadFile(wgPrivKeyPath()); e == nil {
		privKey = strings.TrimSpace(string(data))
	}
	if privKey == "" {
		privKey, err = runWGTool("wg.exe", "genkey")
		if err != nil {
			return "", "", fmt.Errorf("wg genkey: %w", err)
		}
		if err = os.WriteFile(wgPrivKeyPath(), []byte(privKey), 0600); err != nil {
			return "", "", err
		}
	}
	wgBin, err := findWGTool("wg.exe")
	if err != nil {
		return "", "", err
	}
	cmd := exec.Command(wgBin, "pubkey")
	cmd.Stdin = strings.NewReader(privKey + "\n")
	out, err := cmd.Output()
	if err != nil {
		return "", "", fmt.Errorf("wg pubkey: %w", err)
	}
	pubKey = strings.TrimSpace(string(out))
	_ = os.WriteFile(wgPubKeyPath(), []byte(pubKey), 0600)
	return privKey, pubKey, nil
}

func configureClientInterface(allowedIPs, serverPubKey, serverEndpoint, serverAllowedIPs string) error {
	if err := os.MkdirAll(appDataDir(), 0700); err != nil {
		return err
	}
	privData, err := os.ReadFile(wgPrivKeyPath())
	if err != nil {
		return fmt.Errorf("read private key: %w", err)
	}
	privKey := strings.TrimSpace(string(privData))

	cfg := fmt.Sprintf("[Interface]\r\nPrivateKey = %s\r\nAddress = %s\r\nListenPort = 51002\r\n\r\n[Peer]\r\nPublicKey = %s\r\nAllowedIPs = %s\r\nEndpoint = %s\r\nPersistentKeepalive = 25\r\n",
		privKey, allowedIPs, serverPubKey, serverAllowedIPs, serverEndpoint)

	confPath := wgConfPath()
	if err := os.WriteFile(confPath, []byte(cfg), 0600); err != nil {
		return err
	}

	bringDownVPN()
	if _, err := runWGTool("wireguard.exe", "/installtunnelservice", confPath); err != nil {
		return fmt.Errorf("install tunnel: %w", err)
	}
	return nil
}

func bringDownVPN() {
	runWGTool("wireguard.exe", "/uninstalltunnelservice", wgClientIface)
}

func getConnectionStatusMap(servers []Server) map[string]bool {
	result := make(map[string]bool)
	out, err := runWGTool("wg.exe", "show", wgClientIface, "latest-handshakes")
	if err != nil || out == "" {
		return result
	}

	peerHandshakes := make(map[string]int64)
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Fields(strings.TrimSpace(line))
		if len(parts) < 2 {
			continue
		}
		var ts int64
		fmt.Sscanf(parts[1], "%d", &ts)
		peerHandshakes[parts[0]] = ts
	}

	now := time.Now().Unix()
	for _, s := range servers {
		key := fmt.Sprintf("%s:%d", s.IP, s.Port)
		if hs, ok := peerHandshakes[s.PublicKey]; ok && hs > 0 && hs <= now && (now-hs) <= 180 {
			result[key] = true
		}
	}
	return result
}

func isAdmin() bool {
	_, err := exec.Command("net", "session").CombinedOutput()
	return err == nil
}

func getDeviceName() string {
	name, err := os.Hostname()
	if err != nil {
		return "windows-client"
	}
	return strings.TrimSpace(name)
}

func getMachineID() string {
	path := filepath.Join(appDataDir(), "machine.id")
	if data, err := os.ReadFile(path); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}
	out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-CimInstance Win32_ComputerSystemProduct).UUID",
	).Output()
	if err == nil {
		if id := strings.TrimSpace(string(out)); id != "" {
			_ = os.MkdirAll(appDataDir(), 0700)
			_ = os.WriteFile(path, []byte(id), 0600)
			return id
		}
	}
	return ""
}
