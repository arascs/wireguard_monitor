import sys
import json
import re
from datetime import datetime, timezone, timedelta

PEERS_FILE = "/root/wireguard_monitor/wireguard_monitor/app/config/peers.json"
EVENT_FILE = "/root/wireguard_monitor/wireguard_monitor/app/endpoint_events.json"
INTERFACE = "wgA"

# load peers
with open(PEERS_FILE) as f:
    data = json.load(f)

peers = data.get(INTERFACE, [])

# build set endpoint hợp lệ
valid_endpoints = set()
for p in peers:
    valid_endpoints.add(p["endpoint"])

# regex parse tcpdump line
# ví dụ: 172.16.0.2.51820 >
regex = re.compile(r'(\d+\.\d+\.\d+\.\d+)\.(\d+)\s*>')

def now_iso():
    tz = timezone(timedelta(hours=7))
    return datetime.now(tz).isoformat()

def log_event(event):
    with open(EVENT_FILE, "a") as f:
        f.write(json.dumps(event) + "\n")

for line in sys.stdin:
    line = line.strip()

    m = regex.search(line)
    if not m:
        continue

    ip = m.group(1)
    port = m.group(2)
    endpoint = f"{ip}:{port}"

    # nếu không match peer nào
    if endpoint not in valid_endpoints:
        event = {
            "timestamp": now_iso(),
            "event_name": "unknown_peer_handshake",
            "details": {
                "interface": INTERFACE,
                "endpoint": endpoint
            }
        }

        log_event(event)