package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var httpClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	},
}

func serverURL(ip string, port int, path string) string {
	return fmt.Sprintf("https://%s:%d%s", ip, port, path)
}

func doPost(ip string, port int, path, token string, body interface{}) (*http.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest("POST", serverURL(ip, port, path), bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return httpClient.Do(req)
}

type baseResp struct {
	Success bool     `json:"success"`
	Error   string   `json:"error"`
	Message string   `json:"message"`
	Token   string   `json:"token"`
	Issues  []string `json:"issues"`
}

func formatAPIError(msg string, issues []string) string {
	if msg != "" {
		return msg
	}
	return strings.Join(issues, "; ")
}

func decodeBase(resp *http.Response) (baseResp, int, error) {
	defer resp.Body.Close()
	var r baseResp
	err := json.NewDecoder(resp.Body).Decode(&r)
	return r, resp.StatusCode, err
}

func apiLogin(ip string, port int, username, password string) (string, error) {
	resp, err := doPost(ip, port, "/api/login", "", map[string]string{
		"username": username, "password": password,
	})
	if err != nil {
		return "", err
	}
	r, _, err := decodeBase(resp)
	if err != nil {
		return "", err
	}
	if !r.Success {
		return "", fmt.Errorf("%s", r.Error)
	}
	return r.Token, nil
}

func apiEnroll(ip string, port int, token, username, deviceName, machineID, publicKey string) error {
	resp, err := doPost(ip, port, "/api/enroll-device", token, map[string]interface{}{
		"username": username, "deviceName": deviceName,
		"machineId": machineID, "publicKey": publicKey, "os": clientOS,
	})
	if err != nil {
		return err
	}
	r, _, err := decodeBase(resp)
	if err != nil {
		return err
	}
	if !r.Success {
		return fmt.Errorf("%s", r.Error)
	}
	return nil
}

func apiCheckEnroll(ip string, port int, token, username, deviceName string) (bool, error) {
	resp, err := doPost(ip, port, "/api/check-device-enroll", token, map[string]string{
		"username": username, "deviceName": deviceName,
	})
	if err != nil {
		return false, err
	}
	r, _, err := decodeBase(resp)
	if err != nil {
		return false, err
	}
	msg := strings.ToLower(r.Message)
	enrolled := r.Success && strings.Contains(msg, "enrolled") && !strings.Contains(msg, "not enrolled")
	return enrolled, nil
}

type connectResp struct {
	Success          bool     `json:"success"`
	Error            string   `json:"error"`
	Issues           []string `json:"issues"`
	AllowedIPs       string   `json:"allowedIPs"`
	ServerPublicKey  string   `json:"serverPublicKey"`
	ServerEndpoint   string   `json:"serverEndpoint"`
	ServerAllowedIPs string   `json:"serverAllowedIPs"`
}

func apiConnect(ip string, port int, token, username, deviceName string) (*connectResp, error) {
	secInfo := getSecurityInfo()
	data, _ := json.Marshal(map[string]interface{}{
		"username": username, "deviceName": deviceName, "securityInfo": secInfo,
	})
	req, _ := http.NewRequest("POST", serverURL(ip, port, "/api/connect-vpn"), bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result connectResp
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if !result.Success {
		return nil, fmt.Errorf("%s", formatAPIError(result.Error, result.Issues))
	}
	return &result, nil
}

func apiDisconnect(ip string, port int, token, deviceName string) error {
	resp, err := doPost(ip, port, "/api/disconnect-vpn", token, map[string]string{
		"deviceName": deviceName,
	})
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

type heartbeatResp struct {
	Success bool     `json:"success"`
	Error   string   `json:"error"`
	Issues  []string `json:"issues"`
}

func apiSendHeartbeat(ip string, port int, token, deviceName, machineID string, secInfo SecurityInfo) (bool, error) {
	data, _ := json.Marshal(map[string]interface{}{
		"deviceName":   deviceName,
		"machineId":    machineID,
		"securityInfo": secInfo,
	})
	req, _ := http.NewRequest("POST", serverURL(ip, port, "/api/device-heartbeat"), bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	var result heartbeatResp
	json.NewDecoder(resp.Body).Decode(&result)

	if resp.StatusCode == 403 {
		return false, fmt.Errorf("%s", formatAPIError(result.Error, result.Issues))
	}
	return result.Success, nil
}
