#!/usr/bin/env python3

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta

import requests  # pip3 install requests

WG_DIR          = "/etc/wireguard"
AUDIT_LOG_FILE  = "/opt/wireguard_monitor/app/audit_log.json"
SETTINGS_FILE   = "/opt/wireguard_monitor/app/backend/settings.json"
LOCAL_API       = "http://127.0.0.1:3000"
PEER_API_PORT   = 3000          # default port on peer side
REQUEST_TIMEOUT = 5             # seconds


# ── Global Settings ───────────────────────────────────────────

def load_settings():
    default_settings = {
        "keyExpiryDays": 90,
        "peerDisableHours": 12,
        "keyRenewalTime": "08:00"
    }
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, "r") as f:
                data = json.load(f)
                default_settings.update(data)
    except Exception as e:
        log(f"[SETTINGS] error loading {SETTINGS_FILE}: {e}")
    return default_settings



# ── Helpers ───────────────────────────────────────────────────

def run(*cmd):
    """Run a command and return stdout as a stripped string."""
    return subprocess.check_output(list(cmd), text=True, stderr=subprocess.PIPE).strip()


def run_shell(cmd):
    """Run a shell command (bash) and return stdout."""
    return subprocess.check_output(cmd, shell=True, executable="/bin/bash",
                                   text=True, stderr=subprocess.PIPE).strip()


def log(msg):
    print(f"[wg_key_renewal] {msg}", flush=True)


# ── Audit log (mirrors auditLogger.js) ───────────────────────

def write_audit_log(action, details):
    entry = {
        "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        "admin": "System",
        "action": action,
        "details": details or {}
    }
    arr = []
    try:
        if os.path.exists(AUDIT_LOG_FILE):
            with open(AUDIT_LOG_FILE, "r") as f:
                data = f.read().strip()
            if data:
                arr = json.loads(data)
            if not isinstance(arr, list):
                arr = []
    except Exception as e:
        log(f"[AUDIT] read error: {e}")

    arr.append(entry)
    try:
        os.makedirs(os.path.dirname(AUDIT_LOG_FILE), exist_ok=True)
        with open(AUDIT_LOG_FILE, "w") as f:
            json.dump(arr, f, indent=2)
    except Exception as e:
        log(f"[AUDIT] write error: {e}")


# ── Config file parsing ────────────────────────────────────────

def parse_conf(conf_path, default_expiry):
    """
    Returns a dict with:
      private_key, key_creation_date (ISO str or None), key_expiry_days (int)
    and the raw lines list.
    """
    info = {
        "private_key": None,
        "key_creation_date": None,
        "key_expiry_days": default_expiry,
    }
    with open(conf_path, "r") as f:
        lines = f.readlines()

    for line in lines:
        stripped = line.strip()
        # commented metadata
        m_commented = re.match(r'^#\s*(.+?)\s*=\s*(.+)$', stripped)
        if m_commented:
            key_raw = m_commented.group(1).lower()
            val = m_commented.group(2).strip()
            if key_raw == "key creation":
                info["key_creation_date"] = val
            elif key_raw == "key expiry days":
                try:
                    info["key_expiry_days"] = int(val)
                except ValueError:
                    pass
            continue
        # live key-value
        m = re.match(r'^(\w+)\s*=\s*(.+)$', stripped)
        if m:
            k = m.group(1).lower()
            v = m.group(2).strip()
            if k == "privatekey":
                info["private_key"] = v

    return info, lines


def is_expired(key_creation_date_str, key_expiry_days):
    if not key_creation_date_str:
        return False  # no date → treat as not expired
    try:
        creation = datetime.fromisoformat(key_creation_date_str.replace("Z", "+00:00"))
        expiry = creation + timedelta(days=key_expiry_days)
        return datetime.now(timezone.utc) > expiry
    except Exception:
        return False


# ── Config file rewriting ─────────────────────────────────────

def rewrite_conf(conf_path, lines, old_private_key, new_private_key, new_creation_iso):
    """
    Replace `PrivateKey = <old>` with `new_private_key`
    and update/insert `# Key Creation = <iso>` in the [Interface] section.
    """
    new_lines = []
    creation_written = False
    inside_interface = False

    for line in lines:
        stripped = line.strip()

        # track section
        if stripped == "[Interface]":
            inside_interface = True
        elif stripped.startswith("[") and stripped != "[Interface]":
            # entering another section; if we haven't written the creation line yet, do it now
            if inside_interface and not creation_written:
                new_lines.append(f"# Key Creation = {new_creation_iso}\n")
                creation_written = True
            inside_interface = False

        # replace the creation date comment
        if inside_interface and re.match(r'^#\s*key creation\s*=', stripped, re.IGNORECASE):
            new_lines.append(f"# Key Creation = {new_creation_iso}\n")
            creation_written = True
            continue

        # replace the private key
        if inside_interface and re.match(r'^PrivateKey\s*=', stripped, re.IGNORECASE):
            # write creation line right before PrivateKey if not done yet
            if not creation_written:
                new_lines.append(f"# Key Creation = {new_creation_iso}\n")
                creation_written = True
            new_lines.append(f"PrivateKey = {new_private_key}\n")
            continue

        new_lines.append(line)

    # edge case: single-section file, no peer blocks following interface
    if inside_interface and not creation_written:
        # insert after [Interface] line  (already past it; append at end)
        new_lines.append(f"# Key Creation = {new_creation_iso}\n")

    with open(conf_path, "w") as f:
        f.writelines(new_lines)


# ── Peer distribution ─────────────────────────────────────────

def get_peer_endpoints(lines):
    """Parse [Peer] sections and return list of endpoint strings."""
    endpoints = []
    in_peer = False
    current_endpoint = None
    for line in lines:
        stripped = line.strip()
        clean = re.sub(r'^#\s*', '', stripped)
        if clean == "[Peer]":
            if current_endpoint:
                endpoints.append(current_endpoint)
            in_peer = True
            current_endpoint = None
        elif clean.startswith("[") and clean != "[Peer]":
            if in_peer and current_endpoint:
                endpoints.append(current_endpoint)
            in_peer = False
            current_endpoint = None
        elif in_peer:
            m = re.match(r'^Endpoint\s*=\s*(.+)$', clean, re.IGNORECASE)
            if m:
                current_endpoint = m.group(1).strip()
    if in_peer and current_endpoint:
        endpoints.append(current_endpoint)
    return endpoints


def notify_local_api(old_pub, new_pub):
    """Tell the local wg-monitor server to update peer config files (via /api/update-key)."""
    try:
        r = requests.post(
            f"{LOCAL_API}/api/update-key",
            json={"oldPublicKey": old_pub, "newPublicKey": new_pub},
            timeout=REQUEST_TIMEOUT
        )
        log(f"  local API update-key → {r.status_code}")
    except Exception as e:
        log(f"  local API update-key failed: {e}")


def notify_peers(endpoints, old_pub, new_pub):
    """Send the new public key to each peer endpoint."""
    for ep in endpoints:
        parts = ep.split(":")
        if len(parts) != 2:
            continue
        peer_ip, peer_port = parts[0], parts[1]
        try:
            url = f"http://{peer_ip}:{peer_port}/api/update-key"
            r = requests.post(
                url,
                json={"oldPublicKey": old_pub, "newPublicKey": new_pub},
                timeout=REQUEST_TIMEOUT
            )
            log(f"  peer {peer_ip}:{peer_port} → {r.status_code}")
        except Exception as e:
            log(f"  peer {peer_ip}:{peer_port} failed: {e}")


# ── Interface sync ────────────────────────────────────────────

def get_running_interfaces():
    try:
        out = run("wg", "show", "interfaces")
        return out.split() if out else []
    except Exception:
        return []


def syncconf(iface):
    try:
        run_shell(f"wg syncconf {iface} <(wg-quick strip {iface})")
        log(f"  syncconf {iface} OK")
    except Exception as e:
        log(f"  syncconf {iface} failed: {e}")


# ── Main ──────────────────────────────────────────────────────

def main():
    if not os.path.isdir(WG_DIR):
        log(f"WireGuard config dir not found: {WG_DIR}")
        sys.exit(0)

    conf_files = sorted(
        f for f in os.listdir(WG_DIR) if f.endswith(".conf")
    )

    if not conf_files:
        log("No .conf files found, nothing to do.")
        return

    running_ifaces = get_running_interfaces()
    renewed_count = 0

    settings = load_settings()
    default_expiry = settings.get("keyExpiryDays", 90)

    for conf_file in conf_files:
        iface = conf_file[:-5]  # strip .conf
        conf_path = os.path.join(WG_DIR, conf_file)

        log(f"Checking {iface} ...")
        try:
            info, lines = parse_conf(conf_path, default_expiry)
        except Exception as e:
            log(f"  parse error: {e}")
            continue

        if not is_expired(info["key_creation_date"], info["key_expiry_days"]):
            log(f"  key OK (not expired)")
            continue

        log(f"  key EXPIRED — generating new key pair ...")

        try:
            old_private_key = info["private_key"] or ""
            old_public_key  = run("wg", "pubkey") if not old_private_key else ""
            if old_private_key:
                old_public_key = run_shell(f'echo "{old_private_key}" | wg pubkey')

            new_private_key = run("wg", "genkey")
            new_public_key  = run_shell(f'echo "{new_private_key}" | wg pubkey')
            new_creation    = datetime.now(timezone.utc).isoformat()

            # rewrite conf
            rewrite_conf(conf_path, lines, old_private_key, new_private_key, new_creation)
            log(f"  conf updated → new pubkey: {new_public_key[:20]}...")

            # sync if running
            if iface in running_ifaces:
                syncconf(iface)

            # get peer endpoints from original lines (before rewrite)
            endpoints = get_peer_endpoints(lines)

            # notify local API (updates peer public-key references in other confs)
            notify_local_api(old_public_key, new_public_key)

            # distribute to remote peers
            if endpoints:
                log(f"  distributing to {len(endpoints)} peer endpoint(s)...")
                notify_peers(endpoints, old_public_key, new_public_key)

            # audit log
            write_audit_log("auto_renew_key", {
                "interface": iface,
                "old_public_key": old_public_key,
                "new_public_key": new_public_key,
                "key_expiry_days": info["key_expiry_days"],
                "renewed_at": new_creation,
                "peers_notified": len(endpoints)
            })

            log(f"  renewal complete for {iface}")
            renewed_count += 1

        except Exception as e:
            log(f"  ERROR renewing {iface}: {e}")
            write_audit_log("auto_renew_key_error", {
                "interface": iface,
                "error": str(e)
            })

    log(f"Done. {renewed_count}/{len(conf_files)} interface(s) renewed.")


if __name__ == "__main__":
    main()
