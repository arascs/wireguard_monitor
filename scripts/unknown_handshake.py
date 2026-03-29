import sys
import re
from datetime import datetime, timezone, timedelta
import pymysql

EVENT_FILE = "/root/wireguard_monitor/wireguard_monitor/app/endpoint_events.json"
INTERFACE = "wgA"

DB_CONFIG = {
    'host': 'localhost',
    'user': 'root',
    'password': 'root',
    'database': 'wg_monitor'
}

conn = pymysql.connect(**DB_CONFIG)
cursor = conn.cursor(pymysql.cursors.DictCursor)
cursor.execute("SELECT site_endpoint FROM sites")
rows = cursor.fetchall()
cursor.close()
conn.close()

valid_endpoints = set()
for row in rows:
    ep = row['site_endpoint']
    if ep:
        valid_endpoints.add(ep.strip())

regex = re.compile(r'(\d+\.\d+\.\d+\.\d+)\.(\d+)\s*>')

def now_iso():
    tz = timezone(timedelta(hours=7))
    return datetime.now(tz).isoformat()

def log_event(event):
    import json
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