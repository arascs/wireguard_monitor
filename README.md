# WireGuard VPN Monitoring System

A web-based monitoring and management system for **WireGuard VPN**, designed for administrators to easily configure interfaces and peers, and to monitor real-time and historical VPN statistics.

---

## Features

### Admin

#### Configuration
- Create, edit, and delete **WireGuard interfaces**
- Manage peers for each interface
- Manage client-to-site connections using user identity and device enrollment
- Apply access rules to internal applications
- Create new key pair and synchronize key to other peers
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
