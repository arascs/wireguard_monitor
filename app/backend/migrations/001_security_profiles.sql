CREATE TABLE IF NOT EXISTS security_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  os_type ENUM('linux', 'windows') NOT NULL,
  checks JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE devices
  ADD COLUMN security_profile_id INT NULL,
  ADD CONSTRAINT fk_devices_security_profile
    FOREIGN KEY (security_profile_id) REFERENCES security_profiles(id)
    ON DELETE SET NULL;

INSERT INTO security_profiles (name, os_type, checks) VALUES
  ('Basic Linux', 'linux', '{}'),
  ('Basic Windows', 'windows', '{}');
