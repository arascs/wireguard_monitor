#!/bin/bash
# wg_disable_peer.sh <interface> <publicKey>
# Disables a WireGuard peer by commenting out its [Peer] block in the conf file,
# then syncs the running interface (if up).
set -e

IFACE="$1"
PUB_KEY="$2"
CONF="/etc/wireguard/${IFACE}.conf"

if [ -z "$IFACE" ] || [ -z "$PUB_KEY" ]; then
  echo "Usage: $0 <interface> <publicKey>" >&2
  exit 1
fi

if [ ! -f "$CONF" ]; then
  echo "Config file not found: $CONF" >&2
  exit 1
fi

python3 - "$CONF" "$PUB_KEY" <<'PYEOF'
import sys, re, os

conf_path = sys.argv[1]
target_key = sys.argv[2]

with open(conf_path) as f:
    content = f.read()

lines = content.split('\n')
# Find peer sections
peer_starts = [i for i, l in enumerate(lines) if re.sub(r'^#\s*', '', l.strip()) == '[Peer]']

found_start = None
found_end = None
for s_idx, start in enumerate(peer_starts):
    end = peer_starts[s_idx + 1] - 1 if s_idx + 1 < len(peer_starts) else len(lines) - 1
    for i in range(start, end + 1):
        clean = re.sub(r'^#\s*', '', lines[i].strip())
        m = re.match(r'^PublicKey\s*=\s*(.+)', clean, re.IGNORECASE)
        if m and m.group(1).strip() == target_key:
            found_start, found_end = start, end
            break
    if found_start is not None:
        break

if found_start is None:
    print(f"Peer not found: {target_key}", file=sys.stderr)
    sys.exit(1)

# Comment out lines in the peer block
for i in range(found_start, found_end + 1):
    if lines[i].strip() and not lines[i].strip().startswith('#'):
        lines[i] = '# ' + lines[i]

with open(conf_path, 'w') as f:
    f.write('\n'.join(lines))

print(f"Peer disabled in {conf_path}")
PYEOF

# Sync if interface is running
if wg show interfaces 2>/dev/null | grep -qw "$IFACE"; then
  bash -c "wg syncconf ${IFACE} <(wg-quick strip ${IFACE})" && echo "Synced $IFACE"
fi
