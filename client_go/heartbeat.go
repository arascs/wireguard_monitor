package main

import (
	"log"
	"sync"
	"time"
)

const heartbeatInterval = 60 * time.Second

// HeartbeatManager manages the per-connection heartbeat goroutine.
// After connect succeeds, call Start(). On disconnect or 403, it stops automatically.
type HeartbeatManager struct {
	mu         sync.Mutex
	stopCh     chan struct{}
	running    bool
	count      int
	lastSentAt time.Time
	failed     bool
	failReason string

	// Connection context
	serverIP   string
	serverPort int
	token      string
	deviceName string
	machineID  string

	// Callbacks (called from goroutine – must be goroutine-safe)
	onTick   func(count int, lastSent time.Time) // called after successful heartbeat
	onFailed func(reason string)                 // called when server rejects or network fails
}

func NewHeartbeatManager() *HeartbeatManager {
	return &HeartbeatManager{}
}

// Start begins a new heartbeat loop. Stops any existing loop first.
func (h *HeartbeatManager) Start(
	serverIP string, serverPort int,
	token, deviceName, machineID string,
	onTick func(int, time.Time),
	onFailed func(string),
) {
	h.mu.Lock()
	// Stop existing goroutine if running
	if h.running && h.stopCh != nil {
		close(h.stopCh)
	}
	h.stopCh = make(chan struct{})
	h.serverIP = serverIP
	h.serverPort = serverPort
	h.token = token
	h.deviceName = deviceName
	h.machineID = machineID
	h.onTick = onTick
	h.onFailed = onFailed
	h.count = 0
	h.failed = false
	h.failReason = ""
	h.running = true
	stopCh := h.stopCh
	h.mu.Unlock()

	go h.loop(stopCh)
}

// Stop terminates the heartbeat goroutine.
func (h *HeartbeatManager) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.running && h.stopCh != nil {
		select {
		case <-h.stopCh:
		default:
			close(h.stopCh)
		}
		h.running = false
	}
}

// Stats returns current heartbeat statistics.
func (h *HeartbeatManager) Stats() (running bool, count int, lastSent time.Time, failed bool, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.running, h.count, h.lastSentAt, h.failed, h.failReason
}

func (h *HeartbeatManager) loop(stopCh chan struct{}) {
	// Send immediately on start, then every 60s
	h.sendBeat(stopCh)

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-stopCh:
			log.Println("[heartbeat] stopped")
			return
		case <-ticker.C:
			h.sendBeat(stopCh)
		}
	}
}

func (h *HeartbeatManager) sendBeat(stopCh chan struct{}) {
	h.mu.Lock()
	ip := h.serverIP
	port := h.serverPort
	token := h.token
	deviceName := h.deviceName
	machineID := h.machineID
	onTick := h.onTick
	onFailed := h.onFailed
	h.mu.Unlock()

	secInfo := getSecurityInfo()
	ok, err := apiSendHeartbeat(ip, port, token, deviceName, machineID, secInfo)

	h.mu.Lock()
	defer h.mu.Unlock()

	if err != nil || !ok {
		reason := "network error"
		if err != nil {
			reason = err.Error()
		}
		log.Printf("[heartbeat] FAILED: %s", reason)
		h.failed = true
		h.failReason = reason
		h.running = false
		select {
		case <-stopCh:
		default:
			close(stopCh)
		}
		if onFailed != nil {
			go onFailed(reason)
		}
		return
	}

	h.count++
	h.lastSentAt = time.Now()
	log.Printf("[heartbeat] OK #%d at %s", h.count, h.lastSentAt.Format("15:04:05"))
	if onTick != nil {
		count := h.count
		lastSent := h.lastSentAt
		go onTick(count, lastSent)
	}
}
