#!/usr/bin/env python3
import time
import subprocess
import os
import logging
import xml.etree.ElementTree as ET
import shutil
import json
from datetime import datetime
import pymysql
import ipaddress

INTERVAL = 5
LOG_FILE = "/etc/wireguard/logs/vpn_monitor.log"
STATUS_FILE = "/dev/shm/vpn_live_status.json"
HISTORY_DIR = "/etc/wireguard/logs/vpn_history"

CONNTRACK_CMD = shutil.which("conntrack") or "conntrack"

DB_CONFIG = {
    'host': 'localhost',
    'user': 'root',
    'password': 'root',
    'database': 'wg_monitor',
    'cursorclass': pymysql.cursors.DictCursor
}

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

class VPNMonitor:
    def __init__(self):
        self.peers_list = []
        self.resources_map = {}
        self.sessions = {}
        self.last_load_time = 0

        if not os.path.exists(HISTORY_DIR):
            os.makedirs(HISTORY_DIR, exist_ok=True)

    def load_config(self):
        try:
            conn = pymysql.connect(**DB_CONFIG)
            cursor = conn.cursor()

            new_peers_list = []

            cursor.execute("SELECT id, site_name, site_allowedIPs, interface FROM sites")
            sites = cursor.fetchall()
            for site in sites:
                raw_ips = site['site_allowedIPs'].split(',')
                for item in raw_ips:
                    item = item.strip()
                    if not item: continue
                    try:
                        network = ipaddress.ip_network(item, strict=False)
                        new_peers_list.append({
                            'network': network,
                            'id': str(site.get('id', '')),
                            'name': site['site_name'],
                            'interface': site.get('interface', 'unknown'),
                            'peer_kind': 'site',
                            'username': '',
                            'device_name': ''
                        })
                    except ValueError: continue

            cursor.execute("SELECT id, device_name, username, allowed_ips, interface FROM devices")
            devices = cursor.fetchall()
            for dev in devices:
                raw_ips = dev['allowed_ips'].split(',')
                combined_name = f"{dev['username']}_{dev['device_name']}"
                for item in raw_ips:
                    item = item.strip()
                    if not item: continue
                    try:
                        network = ipaddress.ip_network(item, strict=False)
                        new_peers_list.append({
                            'network': network,
                            'id': str(dev.get('id', '')),
                            'name': combined_name,
                            'interface': dev.get('interface', 'unknown'),
                            'peer_kind': 'device',
                            'username': (dev.get('username') or '').strip(),
                            'device_name': (dev.get('device_name') or '').strip()
                        })
                    except ValueError: continue

            self.peers_list = new_peers_list

            cursor.execute("SELECT name, ip, port FROM applications")
            apps = cursor.fetchall()
            new_res = {}
            for app in apps:
                key = f"{str(app['ip']).strip()}:{str(app['port']).strip()}"
                new_res[key] = app['name']
            self.resources_map = new_res

            cursor.close()
            conn.close()
            self.last_load_time = time.time()
            logging.info(f"Config reloaded. Peers: {len(self.peers_list)}, Resources: {len(self.resources_map)}")

        except Exception as e:
            logging.error(f"Failed to load config: {e}")

    def find_peer(self, ip_str):
        try:
            addr = ipaddress.ip_address(ip_str)
            for peer in self.peers_list:
                if addr in peer['network']:
                    return peer
        except ValueError:
            pass
        return None

    def get_conntrack_table(self):
        try:
            output = subprocess.check_output([CONNTRACK_CMD, "-L", "-o", "xml"],
                stderr=subprocess.DEVNULL
            ).decode("utf-8", errors="ignore")
            start = output.find("<conntrack>")
            if start == -1: return None
            return ET.fromstring(output[start:])
        except Exception as e:
            logging.error(f"Conntrack fetch error: {e}")
            return None

    def save_session_history(self, session_data, end_timestamp):
        try:
            date_str = datetime.fromtimestamp(end_timestamp).strftime('%Y-%m-%d')
            history_file = os.path.join(HISTORY_DIR, f"vpn_sessions_{date_str}.json")
            duration = int(end_timestamp - session_data['start_time'])

            history_record = {
                "interface": session_data['interface'],
                "peer_id": session_data['peer_id'],
                "peer_name": session_data['peer_name'],
                "username": session_data.get('username', ''),
                "device_name": session_data.get('device_name', ''),
                "source": f"{session_data['peer_ip']}:{session_data['peer_port']}",
                "resource": f"{session_data['resource_ip']}:{session_data['resource_port']}",
                "service": session_data['service'],
                "protocol": session_data['protocol'],
                "start_time": datetime.fromtimestamp(session_data['start_time']).isoformat(),
                "end_time": datetime.fromtimestamp(end_timestamp).isoformat(),
                "duration_sec": duration,
                "total_bytes": session_data['bytes'],
                "direction1": session_data.get('direction1', {'packets': 0, 'bytes': 0}),
                "direction2": session_data.get('direction2', {'packets': 0, 'bytes': 0})
            }

            with open(history_file, 'a') as f:
                f.write(json.dumps(history_record) + "\n")
        except Exception as e:
            logging.error(f"Save history error: {e}")

    def run(self):
        logging.info(f"VPN Monitor started. Interval: {INTERVAL}s")

        while True:
            self.load_config()
            root = self.get_conntrack_table()
            timestamp = time.time()
            current_scan_keys = set()

            if root is not None:
                flows = root.findall('flow')
                for flow in flows:
                    try:
                        meta_tags = flow.findall('meta')
                        if not meta_tags: continue

                        l3 = meta_tags[0].find('layer3')
                        l4 = meta_tags[0].find('layer4')
                        if l3 is None or l4 is None: continue
                        if l3.get('protoname') != 'ipv4': continue

                        src_ip = l3.find('src').text.strip()
                        dst_ip = l3.find('dst').text.strip()
                        sport = l4.find('sport').text.strip()
                        dport = l4.find('dport').text.strip()

                        protocol = l4.get('protoname')
                        if protocol: protocol = protocol.strip().lower()
                        if protocol not in['tcp', 'udp']: continue

                        peer_info = self.find_peer(src_ip)
                        if not peer_info: continue

                        res_key = f"{dst_ip}:{dport}"
                        service_name = self.resources_map.get(res_key)
                        if not service_name: continue

                        session_key = (src_ip, sport, dst_ip, dport)
                        current_scan_keys.add(session_key)

                        direction1_packets, direction1_bytes = 0, 0
                        direction2_packets, direction2_bytes = 0, 0
                        total_bytes = 0

                        if len(meta_tags) >= 1:
                            counters1 = meta_tags[0].find('counters')
                            if counters1 is not None:
                                p1 = counters1.find('packets')
                                b1 = counters1.find('bytes')
                                if p1 is not None: direction1_packets = int(p1.text)
                                if b1 is not None:
                                    direction1_bytes = int(b1.text)
                                    total_bytes += direction1_bytes

                        if len(meta_tags) >= 2:
                            counters2 = meta_tags[1].find('counters')
                            if counters2 is not None:
                                p2 = counters2.find('packets')
                                b2 = counters2.find('bytes')
                                if p2 is not None: direction2_packets = int(p2.text)
                                if b2 is not None:
                                    direction2_bytes = int(b2.text)
                                    total_bytes += direction2_bytes

                        if session_key not in self.sessions:
                            logging.info(f"START: {peer_info['interface']}/{peer_info['name']} ({src_ip}:{sport}) -> {service_name}")
                            self.sessions[session_key] = {
                                'interface': peer_info['interface'],
                                'peer_id': peer_info['id'],
                                'peer_name': peer_info['name'],
                                'username': peer_info.get('username', ''),
                                'device_name': peer_info.get('device_name', ''),
                                'peer_ip': src_ip,
                                'peer_port': sport,
                                'resource_ip': dst_ip,
                                'resource_port': dport,
                                'service': service_name,
                                'protocol': protocol,
                                'start_time': timestamp,
                                'bytes': total_bytes,
                                'direction1': {'packets': direction1_packets, 'bytes': direction1_bytes},
                                'direction2': {'packets': direction2_packets, 'bytes': direction2_bytes}
                            }
                        else:
                            self.sessions[session_key]['bytes'] = total_bytes
                            self.sessions[session_key]['direction1'] = {'packets': direction1_packets, 'bytes': direction1_bytes}
                            self.sessions[session_key]['direction2'] = {'packets': direction2_packets, 'bytes': direction2_bytes}

                    except (AttributeError, ValueError):
                        continue

            active_keys = list(self.sessions.keys())
            for key in active_keys:
                if key not in current_scan_keys:
                    s = self.sessions[key]
                    duration = int(timestamp - s['start_time'])
                    logging.info(f"STOP: {s['interface']}/{s['peer_name']} ({s['peer_ip']}:{s['peer_port']}) -> {s['service']} | Duration: {duration}s")
                    self.save_session_history(s, timestamp)
                    del self.sessions[key]

            self.export_status()
            elapsed = time.time() - timestamp
            time.sleep(max(0, INTERVAL - elapsed))

    def export_status(self, file_path=STATUS_FILE):
        data = {
            "last_updated": datetime.now().isoformat(),
            "active_connections_count": len(self.sessions),
            "sessions":[]
        }
        for key, s in self.sessions.items():
            data["sessions"].append({
                "interface": s['interface'],
                "peer_id": s['peer_id'],
                "peer_name": s['peer_name'],
                "username": s.get('username', ''),
                "device_name": s.get('device_name', ''),
                "source": f"{s['peer_ip']}:{s['peer_port']}",
                "resource_ip_port": f"{s['resource_ip']}:{s['resource_port']}",
                "service": s['service'],
                "protocol": s['protocol'],
                "start_time": datetime.fromtimestamp(s['start_time']).isoformat(),
                "duration_sec": int(time.time() - s['start_time']),
                "bytes": s['bytes'],
                "direction1": s.get('direction1', {'packets': 0, 'bytes': 0}),
                "direction2": s.get('direction2', {'packets': 0, 'bytes': 0})
            })

        tmp = f"{file_path}.tmp"
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
        os.rename(tmp, file_path)

if __name__ == "__main__":
    monitor = VPNMonitor()
    monitor.run()