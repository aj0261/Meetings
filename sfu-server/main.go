// Full code in one file

package main

import (
	"encoding/json"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

type WsMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type SignalPayload struct {
	Target string          `json:"target"`
	Sender string          `json:"sender"`
	Data   json.RawMessage `json:"data"`
}

type ConnectRequestPayload struct {
	UserID    string `json:"userId"`
	ProjectID string `json:"projectId"`
}

type DisconnectPayload struct {
	UserID string `json:"userId"`
}

type PeerContext struct {
	PeerConnection *webrtc.PeerConnection
	ProjectID      string
	Tracks         []*webrtc.TrackLocalStaticRTP
	lock           sync.Mutex
}

var (
	peers    = make(map[string]*PeerContext)
	mapLock  sync.RWMutex
	connLock sync.Mutex
)

func main() {
	u := url.URL{Scheme: "ws", Host: "localhost:8080", Path: "/ws/sfu-internal-channel"}
	log.Printf("[SFU] Connecting to Hub at %s", u.String())

	var conn *websocket.Conn
	var err error

	for {
		conn, _, err = websocket.DefaultDialer.Dial(u.String(), nil)
		if err == nil {
			break
		}
		log.Printf("[SFU] Failed to connect to hub: %v. Retrying in 5 seconds...", err)
		time.Sleep(5 * time.Second)
	}
	defer conn.Close()
	log.Println("[SFU] Connected to hub")

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[SFU] Read error: %v", err)
			return
		}
		var msg WsMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("[SFU] Failed to parse message: %v", err)
			continue
		}
		switch msg.Type {
		case "webrtc_connect_request":
			handleConnectRequest(conn, msg.Payload)
		case "webrtc_answer":
			handleAnswer(msg.Payload)
		case "webrtc_ice_candidate":
			handleIceCandidate(msg.Payload)
		case "webrtc_disconnect":
			handleDisconnect(msg.Payload)
		}
	}
}

func handleConnectRequest(ws *websocket.Conn, payload json.RawMessage) {
	var req ConnectRequestPayload
	if err := json.Unmarshal(payload, &req); err != nil {
		log.Printf("[SFU] Invalid connect request: %v", err)
		return
	}

	log.Printf("[SFU] ---> Connect request: User %s joining Project %s", req.UserID, req.ProjectID)

	mapLock.Lock()
	if oldPeer, exists := peers[req.UserID]; exists {
		log.Printf("[SFU] Closing old PeerConnection for user %s", req.UserID)
		if err := oldPeer.PeerConnection.Close(); err != nil {
			log.Printf("[SFU] Error closing old PeerConnection: %v", err)
		}
		delete(peers, req.UserID)
	}
	mapLock.Unlock()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	})
	if err != nil {
		log.Printf("[SFU] Failed to create PeerConnection: %v", err)
		return
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candBytes, _ := json.Marshal(c.ToJSON())
		signal := SignalPayload{Target: req.UserID, Sender: "sfu", Data: candBytes}
		payloadBytes, _ := json.Marshal(signal)
		msg, _ := json.Marshal(WsMessage{Type: "webrtc_ice_candidate", Payload: payloadBytes})

		connLock.Lock()
		defer connLock.Unlock()
		if err := ws.WriteMessage(websocket.TextMessage, msg); err != nil {
			log.Printf("[SFU] Failed to send ICE candidate: %v", err)
		}
	})

	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("[SFU] Received audio track from %s", req.UserID)

		go func() {
			localTrack, err := webrtc.NewTrackLocalStaticRTP(
				remoteTrack.Codec().RTPCodecCapability,
				remoteTrack.ID()+"-"+req.UserID,
				remoteTrack.StreamID()+"-"+req.UserID,
			)
			if err != nil {
				log.Printf("[SFU] Failed to create local track: %v", err)
				return
			}

			mapLock.Lock()
			if peer, ok := peers[req.UserID]; ok {
				peer.Tracks = append(peer.Tracks, localTrack)
			}
			mapLock.Unlock()

			mapLock.RLock()
			for otherID, otherPeer := range peers {
				if otherID != req.UserID && otherPeer.ProjectID == req.ProjectID {
					otherPeer.lock.Lock()
					if _, err := otherPeer.PeerConnection.AddTrack(localTrack); err != nil {
						log.Printf("[SFU] Failed to add track to %s: %v", otherID, err)
					}
					otherPeer.lock.Unlock()
				}
			}
			mapLock.RUnlock()

			buf := make([]byte, 1500)
			for {
				n, _, err := remoteTrack.Read(buf)
				if err != nil {
					log.Printf("[SFU] RTP read error for %s: %v", req.UserID, err)
					return
				}
				if _, err := localTrack.Write(buf[:n]); err != nil {
					log.Printf("[SFU] RTP write error: %v", err)
					return
				}
			}
		}()
	})

	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio); err != nil {
		log.Printf("[SFU] Failed to add transceiver: %v", err)
		return
	}

	mapLock.Lock()
	peers[req.UserID] = &PeerContext{
		PeerConnection: pc,
		ProjectID:      req.ProjectID,
		Tracks:         []*webrtc.TrackLocalStaticRTP{},
	}
	mapLock.Unlock()

	mapLock.RLock()
	for otherID, otherPeer := range peers {
		if otherID != req.UserID && otherPeer.ProjectID == req.ProjectID {
			for _, track := range otherPeer.Tracks {
				pc.AddTrack(track)
			}
		}
	}
	mapLock.RUnlock()

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		log.Printf("[SFU] Failed to create offer: %v", err)
		return
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		log.Printf("[SFU] Failed to set local description: %v", err)
		return
	}

	offerBytes, _ := json.Marshal(offer)
	signal := SignalPayload{Target: req.UserID, Sender: "sfu", Data: offerBytes}
	payloadBytes, _ := json.Marshal(signal)
	msg, _ := json.Marshal(WsMessage{Type: "webrtc_offer", Payload: payloadBytes})

	connLock.Lock()
	defer connLock.Unlock()
	if err := ws.WriteMessage(websocket.TextMessage, msg); err != nil {
		log.Printf("[SFU] Failed to send offer: %v", err)
	}
}

func handleAnswer(payload json.RawMessage) {
	var sp SignalPayload
	if err := json.Unmarshal(payload, &sp); err != nil {
		log.Printf("[SFU] Invalid answer: %v", err)
		return
	}
	mapLock.RLock()
	peer, ok := peers[sp.Sender]
	mapLock.RUnlock()
	if !ok {
		log.Printf("[SFU] Peer not found for answer from %s", sp.Sender)
		return
	}

	var answer webrtc.SessionDescription
	if err := json.Unmarshal(sp.Data, &answer); err != nil {
		log.Printf("[SFU] Failed to parse answer: %v", err)
		return
	}
	peer.lock.Lock()
	defer peer.lock.Unlock()
	if err := peer.PeerConnection.SetRemoteDescription(answer); err != nil {
		log.Printf("[SFU] Failed to set remote description: %v", err)
	}
}

func handleIceCandidate(payload json.RawMessage) {
	var sp SignalPayload
	if err := json.Unmarshal(payload, &sp); err != nil {
		log.Printf("[SFU] Invalid ICE payload: %v", err)
		return
	}
	mapLock.RLock()
	peer, ok := peers[sp.Sender]
	mapLock.RUnlock()
	if !ok {
		log.Printf("[SFU] Peer not found for ICE from %s", sp.Sender)
		return
	}
	var cand webrtc.ICECandidateInit
	if err := json.Unmarshal(sp.Data, &cand); err != nil {
		log.Printf("[SFU] Failed to parse ICE candidate: %v", err)
		return
	}
	if err := peer.PeerConnection.AddICECandidate(cand); err != nil {
		log.Printf("[SFU] Failed to add ICE candidate: %v", err)
	}
}

func handleDisconnect(payload json.RawMessage) {
	var req DisconnectPayload
	if err := json.Unmarshal(payload, &req); err != nil {
		log.Printf("[SFU] Invalid disconnect: %v", err)
		return
	}
	mapLock.Lock()
	defer mapLock.Unlock()
	if peer, ok := peers[req.UserID]; ok {
		log.Printf("[SFU] Disconnecting user %s", req.UserID)
		if err := peer.PeerConnection.Close(); err != nil {
			log.Printf("[SFU] Error closing peer: %v", err)
		}
		delete(peers, req.UserID)
	}
}
