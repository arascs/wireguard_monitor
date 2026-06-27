CREATE DATABASE IF NOT EXISTS vpn_monitoring;

USE vpn_monitoring;

CREATE TABLE IF NOT EXISTS wireguard_logs
(
    timestamp VARCHAR(32) NOT NULL,
    origin_host VARCHAR(255) NOT NULL,
    event_type VARCHAR(128) NOT NULL,
    message TEXT NOT NULL,
    data TEXT NOT NULL,
    INDEX idx_timestamp (timestamp),
    INDEX idx_origin_event (origin_host, event_type)
);

CREATE TABLE IF NOT EXISTS operation_logs
(
    ts DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    alert_type VARCHAR(64) NOT NULL,
    node_id VARCHAR(255) NOT NULL,
    node_name VARCHAR(255) NOT NULL,
    detail TEXT NOT NULL,
    INDEX idx_ts (ts),
    INDEX idx_alert_node (alert_type, node_id)
);

CREATE TABLE IF NOT EXISTS devices
(
    machine_id VARCHAR(255) NOT NULL,
    device_name VARCHAR(255) NOT NULL,
    username VARCHAR(255) NOT NULL DEFAULT '',
    public_key VARCHAR(255) NOT NULL,
    `interface` VARCHAR(64) NOT NULL,
    node_id VARCHAR(255) NOT NULL,
    node_name VARCHAR(255) NOT NULL,
    base_url VARCHAR(512) NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (machine_id, node_id),
    INDEX idx_node_id (node_id)
);

CREATE TABLE IF NOT EXISTS admins
(
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL,
    status TINYINT NOT NULL DEFAULT 1,
    expire_day INT UNSIGNED NULL,
    create_day INT UNSIGNED NOT NULL,
    created_by INT UNSIGNED NULL,
    UNIQUE KEY uk_username (username)
);
