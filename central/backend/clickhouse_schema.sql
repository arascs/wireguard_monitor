CREATE DATABASE IF NOT EXISTS vpn_monitoring;

CREATE TABLE IF NOT EXISTS vpn_monitoring.operation_logs
(
    ts DateTime64(3) DEFAULT now64(3),
    alert_type LowCardinality(String),
    node_id String,
    node_name String,
    detail String
)
ENGINE = MergeTree()
ORDER BY (ts, node_id)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS vpn_monitoring.devices
(
    machine_id String,
    device_name String,
    username String,
    public_key String,
    `interface` String,
    node_id String,
    node_name String,
    base_url String,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree()
ORDER BY (machine_id, node_id)
SETTINGS index_granularity = 8192;
