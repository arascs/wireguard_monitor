#!/usr/bin/env python3
import subprocess
import requests
import os
import tempfile

KEY_SERVER = "http://192.168.178.129:52000/fetch"
WG_DIR = "/etc/wireguard"

def run(cmd):
    return subprocess.check_output(cmd, text=True).strip()

def get_interfaces():
    out = run(["wg", "show", "interfaces"])
    return out.split() if out else []

def get_interface_pub(iface):
    return run(["wg", "show", iface, "public-key"])

def syncconf(iface):
    subprocess.check_call(
        f"wg syncconf {iface} <(wg-quick strip {iface})",
        shell=True,
        executable="/bin/bash"
    )

def update_conf(conf_path, updates):
    changed = False
    out = []

    with open(conf_path) as f:
        for line in f:
            stripped = line.strip()
            if stripped.startswith("PublicKey"):
                key = stripped.split("=", 1)[1].strip()
                for u in updates:
                    if key == u["sender_pub"]:
                        line = f"PublicKey = {u['new_sender_pub']}\n"
                        changed = True
                        break
            out.append(line)

    if changed:
        with open(conf_path, "w") as f:
            f.writelines(out)

    return changed

def main():
    for iface in get_interfaces():
        conf = f"{WG_DIR}/{iface}.conf"
        if not os.path.exists(conf):
            continue

        iface_pub = get_interface_pub(iface)

        try:
            r = requests.get(KEY_SERVER, params={"pub": iface_pub}, timeout=5)
            updates = r.json()
        except Exception:
            continue

        if not updates:
            continue

        if update_conf(conf, updates):
            syncconf(iface)

if __name__ == "__main__":
    main()