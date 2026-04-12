import glob
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone, timedelta

import pymysql

EVENT_FILE = "/etc/wireguard/logs/endpoint_events.json"
WIREGUARD_CONFIG_GLOB = "/etc/wireguard/*.conf"
RELOAD_SECONDS = 15

DB_CONFIG = {
    'host': 'localhost',
    'user': 'root',
    'password': 'root',
    'database': 'wg_monitor',
    'autocommit': True
}

SOURCE_REGEX = re.compile(
    r'IP\s+(\d+\.\d+\.\d+\.\d+)\.(\d+)\s*>\s*(\d+\.\d+\.\d+\.\d+)\.(\d+):'
)

# --- Tối ưu hiệu năng: Cache file handles và DB connection ---
_FILE_HANDLES = {}
_DB_CONN = None

def get_db_conn():
    global _DB_CONN
    if _DB_CONN is None or not _DB_CONN.open:
        _DB_CONN = pymysql.connect(**DB_CONFIG)
    return _DB_CONN

def get_file_handle(path):
    if path not in _FILE_HANDLES:
        # Đảm bảo thư mục tồn tại trước khi mở file
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _FILE_HANDLES[path] = open(path, "a", encoding="utf-8")
    return _FILE_HANDLES[path]
# -----------------------------------------------------------

def load_valid_endpoints():
    try:
        conn = get_db_conn()
        cursor = conn.cursor(pymysql.cursors.DictCursor)
        cursor.execute("SELECT site_endpoint FROM sites")
        rows = cursor.fetchall()
        cursor.close()

        endpoints = set()
        for row in rows:
            ep = row["site_endpoint"]
            if ep:
                endpoints.add(ep.strip())
        return endpoints
    except Exception:
        # Nếu lỗi DB (mất kết nối), thử đóng để hàm sau khởi tạo lại
        global _DB_CONN
        if _DB_CONN: _DB_CONN.close()
        _DB_CONN = None
        return set()

def now_iso():
    tz = timezone(timedelta(hours=7))
    return datetime.now(tz).isoformat()

def parse_site_interfaces():
    port_to_iface = {}
    for conf_path in glob.glob(WIREGUARD_CONFIG_GLOB):
        iface = os.path.splitext(os.path.basename(conf_path))[0]
        iface_type = ""
        listen_port = None

        with open(conf_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    # Logic comment xử lý type
                    if line.startswith("#"):
                        comment = line[1:].strip()
                        if comment.lower().startswith("type"):
                            parts = comment.split("=", 1)
                            if len(parts) == 2:
                                iface_type = parts[1].strip()
                    continue

                if "=" not in line:
                    continue

                key, value = [x.strip() for x in line.split("=", 1)]
                if key.lower() == "listenport":
                    try:
                        listen_port = int(value)
                    except ValueError:
                        listen_port = None

        if iface_type.lower() == "site" and listen_port is not None:
            port_to_iface[listen_port] = iface

    return port_to_iface

def log_event(event):
    f = get_file_handle(EVENT_FILE)
    f.write(json.dumps(event) + "\n")
    f.flush() # Đảm bảo ghi xuống đĩa ngay nhưng không đóng file

def log_handshake_line(interface_name, line):
    path = f"/etc/wireguard/logs/{interface_name}/handshake.log"
    f = get_file_handle(path)
    f.write(line + "\n")
    f.flush()

def build_tcpdump_cmd(site_ports):
    port_filter = " or ".join([f"udp dst port {p}" for p in site_ports])
    bpf_filter = f"udp and ({port_filter}) and udp[8] = 1"
    # Set interface ens37 in global settings
    return ["tcpdump", "-i", "ens37", "-Q", "in", "-n", "-tttt", "-l", bpf_filter]

def start_tcpdump(site_ports):
    cmd = build_tcpdump_cmd(site_ports)
    return subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1
    )

def safe_stop_tcpdump(proc):
    if proc is None: return
    if proc.poll() is not None: return
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)

def main():
    valid_endpoints = set()
    port_to_iface = {}
    site_ports = []
    proc = None
    last_reload = 0.0

    try:
        while True:
            now = time.time()
            if now - last_reload >= RELOAD_SECONDS:
                last_reload = now
                valid_endpoints = load_valid_endpoints()
                latest_port_to_iface = parse_site_interfaces()
                latest_ports = sorted(latest_port_to_iface.keys())

                if latest_ports != site_ports:
                    safe_stop_tcpdump(proc)
                    proc = None
                    site_ports = latest_ports
                    port_to_iface = latest_port_to_iface
                    if site_ports:
                        proc = start_tcpdump(site_ports)
                else:
                    port_to_iface = latest_port_to_iface

            if not proc or proc.stdout is None:
                time.sleep(1)
                continue

            line = proc.stdout.readline()
            if not line:
                if proc.poll() is not None:
                    proc = start_tcpdump(site_ports) if site_ports else None
                else:
                    time.sleep(0.2)
                continue

            line = line.strip()
            m = SOURCE_REGEX.search(line)
            if not m:
                continue

            src_ip = m.group(1)
            src_port = m.group(2)
            dst_port = int(m.group(4))
            endpoint = f"{src_ip}:{src_port}"
            interface_name = port_to_iface.get(dst_port, "unknown")

            log_handshake_line(interface_name, line)

            if endpoint in valid_endpoints:
                continue

            event = {
                "timestamp": now_iso(),
                "event_name": "unknown_peer_handshake",
                "details": {
                    "interface": interface_name,
                    "endpoint": endpoint,
                },
            }
            log_event(event)
    finally:
        safe_stop_tcpdump(proc)
        # Đóng tất cả file handles khi thoát
        for fh in _FILE_HANDLES.values():
            fh.close()
        if _DB_CONN:
            _DB_CONN.close()

if __name__ == "__main__":
    main()