package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"golang.zx2c4.com/wireguard/wgctrl"
)

type Peer struct {
	Name      string
	PublicKey string
	Endpoint  string
	Interface string
}

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

func loadSitesFromDB(db *sql.DB) ([]Peer, error) {
	rows, err := db.Query("SELECT site_name, site_pubkey, site_endpoint FROM sites")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var peers []Peer
	for rows.Next() {
		var p Peer
		if err := rows.Scan(&p.Name, &p.PublicKey, &p.Endpoint); err != nil {
			continue
		}
		p.Interface = "wgA"
		peers = append(peers, p)
	}
	return peers, nil
}

func writeLog(event Event) {
	f, err := os.OpenFile("/root/wireguard_monitor/wireguard_monitor/app/endpoint_events.json", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
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
	db, err := sql.Open("mysql", "root:root@tcp(localhost:3306)/wg_monitor")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	client, err := wgctrl.New()
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	cache := make(map[string]PeerState)

	peers, err := loadSitesFromDB(db)
	if err != nil {
		log.Fatal(err)
	}

	for _, p := range peers {
		cache[p.PublicKey] = PeerState{
			Interface: p.Interface,
			Peer:      p,
			Endpoint:  p.Endpoint,
		}
	}

	fmt.Println("WireGuard endpoint monitor started")

	for {
		peers, err = loadSitesFromDB(db)
		if err != nil {
			log.Println("DB reload error:", err)
		} else {
			for _, p := range peers {
				if _, exists := cache[p.PublicKey]; !exists {
					cache[p.PublicKey] = PeerState{
						Interface: p.Interface,
						Peer:      p,
						Endpoint:  p.Endpoint,
					}
				}
			}
		}

		ifaceSet := make(map[string]struct{})
		for _, state := range cache {
			ifaceSet[state.Interface] = struct{}{}
		}

		for iface := range ifaceSet {
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