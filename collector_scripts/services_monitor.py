#!/usr/bin/env python3
import time
import json
import subprocess
import os
import logging
import xml.etree.ElementTree as ET
import shutil
from datetime import datetime

# --- CẤU HÌNH ---
INTERVAL = 5  
CONF_DIR = "/root/wireguard_monitor/wireguard_monitor/app/config"
LOG_FILE = "/var/log/vpn_monitor.log"
STATUS_FILE = "/dev/shm/vpn_live_status.json" 
HISTORY_DIR = "/var/log/vpn_history"

# Tự động tìm đường dẫn của lệnh conntrack
CONNTRACK_CMD = shutil.which("conntrack") or "conntrack"

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

class VPNMonitor:
    def __init__(self):
        self.peers_map = {}
        self.resources_map = {}
        self.sessions = {}
        self.last_load_time = 0

        if not os.path.exists(HISTORY_DIR):
            os.makedirs(HISTORY_DIR, exist_ok=True)

    def load_config(self):
        try:
            p_path = f"{CONF_DIR}/peers.json"
            r_path = f"{CONF_DIR}/resources.json"

            p_mtime = os.stat(p_path).st_mtime
            r_mtime = os.stat(r_path).st_mtime

            if p_mtime <= self.last_load_time and r_mtime <= self.last_load_time:
                return

            with open(p_path, 'r') as f:
                data = json.load(f)
                new_peers = {}
                for iface_name, peer_list in data.items():
                    for peer in peer_list:
                        new_peers[peer['IP_VPN'].strip()] = {
                            'id': str(peer['id']),
                            'name': peer['name'],
                            'interface': iface_name
                        }
                self.peers_map = new_peers

            with open(r_path, 'r') as f:
                r_data = json.load(f)
                new_res = {}
                for r in r_data.get('resources',[]):
                    target_ip = r.get('IP') or r.get('IP_VPN')
                    key = f"{str(target_ip).strip()}:{str(r['port']).strip()}"
                    new_res[key] = r['name']
                self.resources_map = new_res

            self.last_load_time = time.time()
            logging.info(f"Config reloaded -> Peers loaded: {list(self.peers_map.keys())}")
            logging.info(f"Config reloaded -> Resources loaded: {list(self.resources_map.keys())}")

        except Exception as e:
            logging.error(f"Failed to load config: {e}")

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
                        meta = flow.find('meta')
                        if meta is None: continue

                        l3 = meta.find('layer3')
                        l4 = meta.find('layer4')

                        if l3 is None or l4 is None: continue
                        if l3.get('protoname') != 'ipv4': continue

                        # Bắt buộc .strip() để xóa các khoảng trắng rác từ file XML
                        src_node = l3.find('src')
                        dst_node = l3.find('dst')
                        sport_node = l4.find('sport')
                        dport_node = l4.find('dport')

                        if None in (src_node, dst_node, sport_node, dport_node):
                            continue

                        src_ip = src_node.text.strip()
                        dst_ip = dst_node.text.strip()
                        sport = sport_node.text.strip()
                        dport = dport_node.text.strip()

                        protocol = l4.get('protoname')
                        if protocol: protocol = protocol.strip().lower()
                        if protocol not in['tcp', 'udp']: continue

                        # --- KIỂM TRA KHỚP (MATCHING) ---
                        peer_info = self.peers_map.get(src_ip)
                        if not peer_info: continue

                        res_key = f"{dst_ip}:{dport}"
                        service_name = self.resources_map.get(res_key)
                        if not service_name: continue

                        session_key = (src_ip, sport, dst_ip, dport)
                        current_scan_keys.add(session_key)

                        direction1_packets, direction1_bytes = 0, 0
                        direction2_packets, direction2_bytes = 0, 0
                        total_bytes = 0

                        meta_tags = flow.findall('meta')
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

                    except AttributeError:
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