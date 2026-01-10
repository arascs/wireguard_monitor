#!/usr/bin/env python3
import time
import json
import subprocess
import os
import logging
import xml.etree.ElementTree as ET
from datetime import datetime

INTERVAL = 5
CONF_DIR = "/home/sara/wireguard_CLI_interactive/config"
LOG_FILE = "/var/log/vpn_monitor.log"
STATUS_FILE = "/dev/shm/vpn_live_status.json" # Ghi vào RAM

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

class VPNMonitor:
    def __init__(self):
        # peers_map: Key = IP_VPN, Value = {id, name, interface}
        self.peers_map = {}
        # resources_map: Key = "IP:Port", Value = service_name
        self.resources_map = {}
        # sessions: Key = (src_ip, sport, dst_ip, dport), Value = SessionData
        self.sessions = {}
        self.last_load_time = 0

    def load_config(self):
        """Load config Peers và Resources"""
        try:
            p_path = f"{CONF_DIR}/peers.json"
            r_path = f"{CONF_DIR}/resources.json"
            
            # Reload nếu file thay đổi (check timestamp của peers hoặc resources)
            p_mtime = os.stat(p_path).st_mtime
            r_mtime = os.stat(r_path).st_mtime
            
            if p_mtime <= self.last_load_time and r_mtime <= self.last_load_time:
                return

            # peers.json
            with open(p_path, 'r') as f:
                data = json.load(f)
                new_peers = {}
                # Duyệt qua từng Interface
                for iface_name, peer_list in data.items():
                    for peer in peer_list:
                        # Map IP -> Thông tin kèm tên Interface
                        new_peers[peer['IP_VPN']] = {
                            'id': peer['id'],
                            'name': peer['name'],
                            'interface': iface_name 
                        }
                self.peers_map = new_peers

            # resources.json
            with open(r_path, 'r') as f:
                r_data = json.load(f)
                new_res = {}
                for r in r_data.get('resources', []):
                    target_ip = r.get('IP_VPN')
                    key = f"{target_ip}:{r['port']}"
                    new_res[key] = r['name']
                self.resources_map = new_res
            
            self.last_load_time = time.time()
            logging.info(f"Config reloaded. Peers: {len(self.peers_map)}, Resources: {len(self.resources_map)}")
            
        except Exception as e:
            logging.error(f"Failed to load config: {e}")

    def get_conntrack_table(self):
        try:
            output = subprocess.check_output(
                ["conntrack", "-L", "-o", "xml"],
                stderr=subprocess.DEVNULL
            ).decode("utf-8", errors="ignore")

            start = output.find("<conntrack>")
            if start == -1:
                raise ValueError("No <conntrack> tag found")

            xml_body = output[start:]
            return ET.fromstring(xml_body)

        except Exception:
            logging.exception("Unexpected error while reading conntrack")
            return None


    def run(self):
        logging.info(f"VPN Monitor started. Interval: {INTERVAL}s")
        
        while True:
            self.load_config()
            root = self.get_conntrack_table()
            #logging.info(f"Scan: Found {len(flows)} flows in conntrack.")
            timestamp = time.time()
            current_scan_keys = set()
            
            if root is not None:
                flows = root.findall('flow')
                logging.info(f"Scan: Found {len(flows)} flows in conntrack.") 
                for flow in flows:
                    try:
                        meta = flow.find('meta')
                        if meta is None: continue
                        
                        l3 = meta.find('layer3')
                        l4 = meta.find('layer4')
                        
                        if l3 is None or l4 is None: continue
                        if l3.get('protoname') != 'ipv4': continue
                        
                        src_ip = l3.find('src').text
                        dst_ip = l3.find('dst').text
                        
                        # Lấy Port (TCP/UDP)
                        protocol = l4.get('protoname')
                        if protocol not in ['tcp', 'udp']: continue
                        sport = l4.find('sport').text
                        dport = l4.find('dport').text
                        
                        # hiểm tra khớp
                        peer_info = self.peers_map.get(src_ip)
                        if not peer_info: continue

                        res_key = f"{dst_ip}:{dport}"
                        service_name = self.resources_map.get(res_key)
                        if not service_name: continue

                        # Key định danh duy nhất: (SrcIP, Sport, DstIP, Dport)
                        session_key = (src_ip, sport, dst_ip, dport)
                        current_scan_keys.add(session_key)

                        # Trích xuất dữ liệu 2 chiều từ conntrack
                        # Mỗi flow có 2 meta tags: original và reply
                        direction1_packets = 0
                        direction1_bytes = 0
                        direction2_packets = 0
                        direction2_bytes = 0
                        total_bytes = 0
                        
                        meta_tags = flow.findall('meta')
                        if len(meta_tags) >= 1:
                            # Direction 1: Peer -> Resource
                            meta1 = meta_tags[0]
                            counters1 = meta1.find('counters')
                            if counters1 is not None:
                                packets_node = counters1.find('packets')
                                bytes_node = counters1.find('bytes')
                                if packets_node is not None:
                                    direction1_packets = int(packets_node.text)
                                if bytes_node is not None:
                                    direction1_bytes = int(bytes_node.text)
                                    total_bytes += direction1_bytes
                        
                        if len(meta_tags) >= 2:
                            # Direction 2: Resource -> Peer
                            meta2 = meta_tags[1]
                            counters2 = meta2.find('counters')
                            if counters2 is not None:
                                packets_node = counters2.find('packets')
                                bytes_node = counters2.find('bytes')
                                if packets_node is not None:
                                    direction2_packets = int(packets_node.text)
                                if bytes_node is not None:
                                    direction2_bytes = int(bytes_node.text)
                                    total_bytes += direction2_bytes

                        # Cập nhật trạng thái
                        if session_key not in self.sessions:
                            # New Session
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
                                'direction1': {
                                    'packets': direction1_packets,
                                    'bytes': direction1_bytes
                                },
                                'direction2': {
                                    'packets': direction2_packets,
                                    'bytes': direction2_bytes
                                }
                            }
                        else:
                            # Update Session
                            self.sessions[session_key]['bytes'] = total_bytes
                            self.sessions[session_key]['direction1'] = {
                                'packets': direction1_packets,
                                'bytes': direction1_bytes
                            }
                            self.sessions[session_key]['direction2'] = {
                                'packets': direction2_packets,
                                'bytes': direction2_bytes
                            }

                    except AttributeError:
                        continue

            # Xóa những kết nối đã DESTROY
            # Những key có trong self.sessions nhưng không có trong current_scan_keys
            # nghĩa là kết nối đã biến mất khỏi bảng conntrack
            active_keys = list(self.sessions.keys())
            for key in active_keys:
                if key not in current_scan_keys:
                    s = self.sessions[key]
                    duration = int(timestamp - s['start_time'])
                    logging.info(f"STOP: {s['interface']}/{s['peer_name']} ({s['peer_ip']}:{s['peer_port']}) -> {s['service']} | Duration: {duration}s | Data: {s['bytes']} bytes")
                    del self.sessions[key]

            # Xuất ra RAM
            self.export_status()
            
            elapsed = time.time() - timestamp
            time.sleep(max(0, INTERVAL - elapsed))

    def export_status(self, file_path=STATUS_FILE):
        data = {
            "last_updated": datetime.now().isoformat(),
            "active_connections_count": len(self.sessions),
            "sessions": []
        }
        
        for key, s in self.sessions.items():
            duration = int(time.time() - s['start_time'])
            data["sessions"].append({
                "interface": s['interface'],
                "peer_id": s['peer_id'],
                "peer_name": s['peer_name'],
                "source": f"{s['peer_ip']}:{s['peer_port']}",
                "resource_ip_port": f"{s['resource_ip']}:{s['resource_port']}",
                "service": s['service'],
                "protocol": s['protocol'],
                "start_time": datetime.fromtimestamp(s['start_time']).isoformat(),
                "duration_sec": duration,
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