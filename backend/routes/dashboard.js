const express = require('express');
const router = express.Router();
const { exec } = require('child_process');

// Parse output wg show all → JSON
function parseWG(output) {
    const peers = [];
    let current = null;

    output.split("\n").forEach(line => {
        line = line.trim();

        if (line.startsWith("peer:")) {
            if (current) peers.push(current);
            current = { peer: line.split("peer:")[1].trim() };
        }

        if (line.startsWith("latest handshake:")) {
            current.handshake = line.replace("latest handshake:", "").trim();
        }

        if (line.startsWith("transfer:")) {
            const t = line.replace("transfer:", "").trim();
            const [recv, sent] = t.split(",").map(x => x.trim());

            current.received = recv;
            current.sent = sent;
        }
    });

    if (current) peers.push(current);
    return peers;
}

// API: /api/dashboard/wg
router.get('/wg', (req, res) => {
    exec("wg show all", (err, stdout, stderr) => {
        if (err) return res.status(500).json({ error: "Cannot run wg" });
        res.json(parseWG(stdout));
    });
});

module.exports = router;
