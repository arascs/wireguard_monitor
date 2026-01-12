#!/bin/bash

if [ "$EUID" -ne 0 ]; then 
  echo "Run the script as root."
  exit 1
fi

echo "Installing neccesary packages..."
apt update
apt install -y wireguard conntrack
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs

echo "Kernel setup..."
# IP Forwarding
sysctl -w net.ipv4.ip_forward=1
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-my-app.conf

sysctl -w net.netfilter.nf_conntrack_acct=1
echo "net.netfilter.nf_conntrack_acct=1" >> /etc/sysctl.d/99-my-app.conf

echo "options nf_conntrack acct=1" > /etc/modprobe.d/nf_conntrack.conf
modprobe -r nf_conntrack || true
modprobe nf_conntrack

mkdir -p /opt/wireguard_monitor
cp -r ./app /opt/wireguard_monitor

cp ./collector_scripts/services_monitor.py /usr/local/bin
cp ./collector_scripts/general_interface_collector.sh /usr/local/bin
cp ./collector_scripts/peer_details_collector.py /usr/local/bin
cp ./key_management_scripts/wg-sync-key.py /usr/local/bin

chmod +x /usr/local/bin/general_interface_collector.sh
chmod +x /usr/local/bin/services_monitor.py
chmod +x /usr/local/bin/peer_details_collector.py
chmod +x /usr/local/bin/wg-sync-key.py

echo "Setting up services..."
cp ./services/services_monitor.service /etc/systemd/system
cp ./services/general_interface_monitor.service /etc/systemd/system
cp ./services/general_interface_monitor.timer /etc/systemd/system
cp ./services/wireguard_monitor.service /etc/systemd/system
cp ./services/peer_details.service /etc/systemd/system
cp ./services/peer_details.timer /etc/systemd/system
cp ./key_management_scripts/wg-sync-key.service /etc/systemd/system
cp ./key_management_scripts/wg-sync-key.timer /etc/systemd/system

systemctl daemon-reload

systemctl enable services_monitor
systemctl start services_monitor

systemctl enable general_interface_monitor.timer
systemctl start general_interface_monitor.timer

systemctl enable peer_details.timer
systemctl start peer_details.timer

systemctl enable wireguard_monitor
systemctl start wireguard_monitor

systemctl enable wg-sync-key.timer
systemctl start wg-sync-key.timer

echo "WireGuard Monitor installation complete."
