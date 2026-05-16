#!/usr/bin/env python3
import subprocess
import os
import json
import time

BASE_DIR = "/etc/wireguard/logs"
MAX_LINES = 60


def public_key_to_log_id(pubkey):
    return pubkey.replace("+", "-").replace("/", "_").rstrip("=")


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def append_jsonl(file_path, data):
    lines = []
    if os.path.exists(file_path):
        with open(file_path, "r") as f:
            lines = f.readlines()
    lines.append(json.dumps(data) + "\n")
    if len(lines) > MAX_LINES:
        lines = lines[-MAX_LINES:]
    with open(file_path, "w") as f:
        f.writelines(lines)


def overwrite_file(file_path, value):
    with open(file_path, "w") as f:
        f.write(str(value))


def main():
    now = int(time.time())

    result = subprocess.run(
        ["wg", "show", "all", "dump"],
        capture_output=True,
        text=True,
        check=True
    )

    current_interface = None

    for line in result.stdout.strip().splitlines():
        parts = line.split()

        if len(parts) == 5:
            current_interface = parts[0]
            continue

        if len(parts) == 9:
            interface = parts[0]
            public_key = parts[1]

            if interface != current_interface:
                current_interface = interface

            latest_handshake = parts[5]
            rx_bytes = int(parts[6])
            tx_bytes = int(parts[7])

            peer_dir = os.path.join(
                BASE_DIR,
                interface,
                public_key_to_log_id(public_key)
            )
            ensure_dir(peer_dir)

            append_jsonl(
                os.path.join(peer_dir, "rx_bytes.json"),
                {"timestamp": now, "value": rx_bytes}
            )

            append_jsonl(
                os.path.join(peer_dir, "tx_bytes.json"),
                {"timestamp": now, "value": tx_bytes}
            )

            overwrite_file(
                os.path.join(peer_dir, "latest_handshake"),
                latest_handshake
            )


if __name__ == "__main__":
    main()
