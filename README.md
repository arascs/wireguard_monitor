# WireGuard VPN Monitoring System

A web-based monitoring and management system for **WireGuard VPN**, designed for administrators to easily configure interfaces and peers, and to monitor real-time and historical VPN statistics.

---

## Local management

### Admin

#### Configuration
- Create, edit, and delete **WireGuard interfaces**
- Manage peers for each interface
- Manage client-to-site connections using user identity and device enrollment
- Apply access rules to internal applications
- Create new key pair and synchronize key to other peers
- Automate disconnecting client after a period (default 12h)
- Decide mandatory security settings (firewall, ssh, kernel version,...) 
- Apply configuration changes directly to the system 

#### Backup and Restore
- Backup and restore configuration files, log files and databases
- Snapshot review for diffing between snapshots

### Client
- Automatically generate key pair to enroll device and join tunnels without manual setup. 

---

### Monitoring & Statistics

#### Interfaces
- Real-time throughput (RX / TX)
- Packet counters
- Dropped packet statistics
- Interface status (up/down)

#### Peers
- RX / TX throughput per peer
- Latest handshake time
- Active connections
- Traffic from peers to **local services**
- Peer online/offline detection

### Audit logs
- Support admin actions, session logging and security alerts on abnormal handshakes and peer endpoint changes.
- Real-time notification on security alerts. 

---

### Data Collection
- Background services and scripts collect:
  - WireGuard statistics (`wg`, `/proc`, netlink)
  - Interface counters
  - Peer traffic metrics
  - `conntrack` to detect sessions to internal applications
  - Packet inspection to detect abnormal handshakes
- Local log files are rotated using `logrotate`
- Data is stored in log files and metric exports for further integration with SOC systems

---

## Central management

### Dashboard
- Overview of total nodes, online count, and estimated alerts in the last 24h
- Site-to-site topology graph showing active links between online nodes
- Aggregate traffic chart (client RX/TX and site RX/TX) per poll interval

### Node Explorer
- List all nodes with CPU, RAM, Disk, throughput, site-to-site peer count, last health check time, and online/offline status
- Filter by name, public IP, and geographic region
- View per-node service status and WireGuard peer details
- Delete a node and automatically clean up peers on connected site-to-site nodes

### Device Registry
- Aggregate all client devices registered across VPN nodes
- Search by machine ID, hostname, or node name
- Delete a device from central and simultaneously remove it from all associated nodes

### Logging
- **Alerts**: browse security event logs pushed by the Vector pipeline into ClickHouse; filter by host, event type, time range, and keyword; view full JSON payload per event
- **Operation Logs**: browse internal logs written by central (node offline, high resource usage, service down, site-to-site connection error); filter by alert type, node, and time range

### Notifications
- Automatic alerts when a node goes offline, resource usage exceeds 90%, a service stops, or a site-to-site peer goes offline
- Bell icon with unread badge and notification panel, refreshed every 5 seconds



## Requirements

- Linux system with:
  - WireGuard installed
  - Root or sudo privileges
- **NodeJS**
- `bash`
- python
- mysql

---

## Installation

```bash
git clone <repo_URL>
cd wireguard-monitor
chmod +x install.sh
./install.sh
