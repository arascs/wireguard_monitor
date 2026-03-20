package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl"
)

type Peer struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	PublicKey string `json:"public_key"`
	IPVPN     string `json:"IP_VPN"`
	Endpoint  string `json:"endpoint"`
}

type Config map[string][]Peer

type PeerState struct {
	Interface string
	Peer      Peer
	Endpoint  string
}

type Event struct {
	Timestamp string      `json:"timestamp"`
	EventName string      `json:"event_name"`
	Details   EventDetail `json:"details"`
}

type EventDetail struct {
	Interface   string `json:"interface"`
	PeerName    string `json:"peer_name"`
	PublicKey   string `json:"public_key"`
	OldEndpoint string `json:"old_endpoint"`
	NewEndpoint string `json:"new_endpoint"`
}

func loadConfig(path string) (Config, error) {

	file, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg Config
	err = json.Unmarshal(file, &cfg)

	return cfg, err
}

func writeLog(event Event) {

	f, err := os.OpenFile("../endpoint_events.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Println(err)
		return
	}

	defer f.Close()

	b, _ := json.Marshal(event)
	f.Write(b)
	f.Write([]byte("\n"))
}

func main() {

	configFile := "../app/config/peers.json"

	cfg, err := loadConfig(configFile)
	if err != nil {
		log.Fatal(err)
	}

	client, err := wgctrl.New()
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	cache := make(map[string]PeerState)

	// initialize cache from config
	for iface, peers := range cfg {

		for _, p := range peers {

			cache[p.PublicKey] = PeerState{
				Interface: iface,
				Peer:      p,
				Endpoint:  p.Endpoint,
			}
		}
	}

	fmt.Println("WireGuard endpoint monitor started")

	for {

		for iface := range cfg {

			dev, err := client.Device(iface)
			if err != nil {
				log.Println("device error:", err)
				continue
			}

			for _, peer := range dev.Peers {

				pub := peer.PublicKey.String()

				state, ok := cache[pub]
				if !ok {
					continue
				}

				var currentEndpoint string
				if peer.Endpoint != nil {
					currentEndpoint = peer.Endpoint.String()
				}

				if state.Endpoint != currentEndpoint {

					event := Event{
						Timestamp: time.Now().Format(time.RFC3339),
						EventName: "peer_endpoint_change",
						Details: EventDetail{
							Interface:   state.Interface,
							PeerName:    state.Peer.Name,
							PublicKey:   pub,
							OldEndpoint: state.Endpoint,
							NewEndpoint: currentEndpoint,
						},
					}

					writeLog(event)

					fmt.Println("Endpoint change detected:", state.Peer.Name)

					state.Endpoint = currentEndpoint
					cache[pub] = state
				}

			}
		}

		time.Sleep(2 * time.Second)
	}
}