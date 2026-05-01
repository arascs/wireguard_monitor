package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Server represents a VPN server entry
type Server struct {
	Name      string `json:"name"`
	IP        string `json:"ip"`
	Port      int    `json:"port"`
	PublicKey string `json:"publicKey,omitempty"`
}

type serversConfig struct {
	Servers []Server `json:"servers"`
}

func serversFilePath() string {
	ex, err := os.Executable()
	if err == nil {
		return filepath.Join(filepath.Dir(ex), "VPN_servers.json")
	}
	return "VPN_servers.json"
}

func loadServers() ([]Server, error) {
	data, err := os.ReadFile(serversFilePath())
	if os.IsNotExist(err) {
		return []Server{}, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg serversConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return cfg.Servers, nil
}

func saveServers(servers []Server) error {
	cfg := serversConfig{Servers: servers}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(serversFilePath(), data, 0644)
}

func addServer(name, ip string, port int) error {
	servers, err := loadServers()
	if err != nil {
		return err
	}
	for _, s := range servers {
		if s.IP == ip && s.Port == port {
			return fmt.Errorf("server already exists")
		}
	}
	servers = append(servers, Server{Name: name, IP: ip, Port: port})
	return saveServers(servers)
}

func deleteServer(ip string, port int) error {
	servers, err := loadServers()
	if err != nil {
		return err
	}
	var filtered []Server
	for _, s := range servers {
		if !(s.IP == ip && s.Port == port) {
			filtered = append(filtered, s)
		}
	}
	return saveServers(filtered)
}

func updateServerPublicKey(ip string, port int, publicKey string) error {
	servers, err := loadServers()
	if err != nil {
		return err
	}
	for i, s := range servers {
		if s.IP == ip && s.Port == port {
			servers[i].PublicKey = publicKey
			return saveServers(servers)
		}
	}
	return nil
}
