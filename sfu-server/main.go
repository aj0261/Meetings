// main.go
package main

import (
	"context"
	"encoding/json"
	"log"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
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
	Senders        []*webrtc.RTPSender // to be able to RemoveTrack on cleanup
	lock           sync.Mutex
}

var (
	peers   = make(map[string]*PeerContext) // key: userID
	mapLock sync.RWMutex

	// WebSocket write queue & connection
	wsConn   *websocket.Conn
	wsLock   sync.RWMutex // protects wsConn access
	writeCh  = make(chan []byte, 256)
	doneCh   = make(chan struct{})
	hubURL   = "ws://localhost:8080/ws/sfu-internal-channel"
	peerConf webrtc.Configuration
)

func main() {
	// Context to cancel background goroutines on exit
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Build ICE servers from environment (support TURN)
	buildICEServersFromEnv()

	// Start writer goroutine
	go wsWriter(ctx)

	// Connect loop with reconnect attempts
	go func() {
		for {
			if err := connectAndServe(ctx); err != nil {
				log.Printf("[SFU] connection loop: %v", err)
			}
			// If context canceled, break
			select {
			case <-ctx.Done():
				return
			default:
			}
			log.Println("[SFU] Reconnecting to hub in 5s...")
			time.Sleep(5 * time.Second)
		}
	}()

	// Handle OS signals to exit gracefully
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-sigs:
		log.Println("[SFU] Received shutdown signal")
	case <-doneCh:
		log.Println("[SFU] Done channel closed")
	}
	cancel()
	// Give some time to cleanup
	time.Sleep(500 * time.Millisecond)
}

// buildICEServersFromEnv populates 'peerConf' with STUN and optional TURN
func buildICEServersFromEnv() {
	turnURL := os.Getenv("TURN_URL")
	turnUser := os.Getenv("TURN_USER")
	turnPass := os.Getenv("TURN_PASS")

	iceServers := []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}}, // default STUN
	}

	if turnURL != "" && turnUser != "" && turnPass != "" {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs:       []string{turnURL},
			Username:   turnUser,
			Credential: turnPass,
		})
		log.Printf("[SFU] Using TURN: %s (user=%s)", turnURL, turnUser)
	} else {
		log.Println("[SFU] No TURN configured via env; relying on STUN only")
	}

	peerConf = webrtc.Configuration{
		ICEServers: iceServers,
	}
}

// connectAndServe connects via websocket, sets up reader and heartbeat, and listens for messages
func connectAndServe(ctx context.Context) error {
	u, err := url.Parse(hubURL)
	if err != nil {
		return err
	}
	log.Printf("[SFU] Connecting to Hub at %s", u.String())

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return err
	}

	// set global connection
	wsLock.Lock()
	wsConn = conn
	wsLock.Unlock()

	// Start heartbeat (ping) goroutine
	ctxPing, cancelPing := context.WithCancel(ctx)
	go wsHeartbeat(ctxPing, conn)

	// Reader loop
	conn.SetReadLimit(65536)
	conn.SetPongHandler(func(appData string) error {
		// got pong; nothing to do (we keep connection healthy)
		return nil
	})

	defer func() {
		cancelPing()
		wsLock.Lock()
		if wsConn != nil {
			_ = wsConn.Close()
			wsConn = nil
		}
		wsLock.Unlock()
	}()

	log.Println("[SFU] Connected to hub")

	// Read messages loop
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[SFU] Read error: %v", err)
			return err
		}
		var msg WsMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("[SFU] Failed to parse message: %v", err)
			continue
		}
		switch msg.Type {
		case "webrtc_connect_request":
			go handleConnectRequest(msg.Payload) // spawn goroutine to avoid blocking reader
		case "webrtc_answer":
			go handleAnswer(msg.Payload)
		case "webrtc_ice_candidate":
			go handleIceCandidate(msg.Payload)
		case "webrtc_disconnect":
			go handleDisconnect(msg.Payload)
		default:
			log.Printf("[SFU] Unknown message type: %s", msg.Type)
		}
	}
}

// wsWriter serializes writes to the WebSocket connection
func wsWriter(ctx context.Context) {
	for {
		select {
		case msg := <-writeCh:
			wsLock.RLock()
			conn := wsConn
			wsLock.RUnlock()
			if conn == nil {
				log.Println("[SFU] writer: no ws connection; dropping message")
				continue
			}
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				log.Printf("[SFU] writer: WriteMessage error: %v", err)
				// close bad connection to trigger reconnect loop
				wsLock.Lock()
				_ = conn.Close()
				wsConn = nil
				wsLock.Unlock()
			}
		case <-ctx.Done():
			return
		}
	}
}

// wsHeartbeat sends pings periodically to keep websocket alive
func wsHeartbeat(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, []byte("ping")); err != nil {
				log.Printf("[SFU] heartbeat: ping error: %v", err)
				// connection likely dead: Reader will handle error and reconnect
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func handleConnectRequest(payload json.RawMessage) {
	var req ConnectRequestPayload
	if err := json.Unmarshal(payload, &req); err != nil {
		log.Printf("[SFU] Invalid connect request: %v", err)
		return
	}

	log.Printf("[SFU] ---> Connect request: User %s joining Project %s", req.UserID, req.ProjectID)

	// Replace existing peer if present
	mapLock.Lock()
	if oldPeer, exists := peers[req.UserID]; exists {
		log.Printf("[SFU] Closing old PeerConnection for user %s", req.UserID)
		oldPeer.lock.Lock()
		if err := oldPeer.PeerConnection.Close(); err != nil {
			log.Printf("[SFU] Error closing old PeerConnection: %v", err)
		}
		oldPeer.lock.Unlock()
		delete(peers, req.UserID)
	}
	mapLock.Unlock()

	// Create new PeerConnection with our ICE servers
	pc, err := webrtc.NewPeerConnection(peerConf)
	if err != nil {
		log.Printf("[SFU] Failed to create PeerConnection: %v", err)
		return
	}

	peerCtx := &PeerContext{
		PeerConnection: pc,
		ProjectID:      req.ProjectID,
		Tracks:         []*webrtc.TrackLocalStaticRTP{},
		Senders:        []*webrtc.RTPSender{},
	}

	// OnICECandidate: send candidate to hub for target user
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candBytes, _ := json.Marshal(c.ToJSON())
		signal := SignalPayload{Target: req.UserID, Sender: "sfu", Data: candBytes}
		payloadBytes, _ := json.Marshal(signal)
		msg, _ := json.Marshal(WsMessage{Type: "webrtc_ice_candidate", Payload: payloadBytes})
		// push to write channel
		writeCh <- msg
	})

	// OnTrack: when a remote user sends an audio track to this SFU peer (we expect user's browser to publish a track)
	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		log.Printf("[SFU] Received track from %s (codec=%s)", req.UserID, remoteTrack.Codec().MimeType)

		// Create a local track to forward that remote track to other peers in same project
		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			remoteTrack.Codec().RTPCodecCapability,
			remoteTrack.ID()+"-"+req.UserID,
			remoteTrack.StreamID()+"-"+req.UserID,
		)
		if err != nil {
			log.Printf("[SFU] Failed to create local track: %v", err)
			return
		}

		// Save the local track under the original publisher's PeerContext so we can cleanup later
		mapLock.Lock()
		if publisher, ok := peers[req.UserID]; ok {
			publisher.lock.Lock()
			publisher.Tracks = append(publisher.Tracks, localTrack)
			publisher.lock.Unlock()
		}
		mapLock.Unlock()

		// Add this localTrack to all other peers in the same project
		mapLock.RLock()
		for otherID, otherPeer := range peers {
			if otherID == req.UserID {
				continue
			}
			if otherPeer.ProjectID != req.ProjectID {
				continue
			}
			otherPeer.lock.Lock()
			sender, err := otherPeer.PeerConnection.AddTrack(localTrack)
			if err != nil {
				log.Printf("[SFU] Failed to add track to %s: %v", otherID, err)
			} else {
				otherPeer.Senders = append(otherPeer.Senders, sender)
			}
			otherPeer.lock.Unlock()
		}
		mapLock.RUnlock()

		// Start read loop: read RTP packets from remoteTrack and forward to localTrack
		buf := make([]byte, 1500)
		for {
			n, _, readErr := remoteTrack.Read(buf)
			if readErr != nil {
				log.Printf("[SFU] RTP read error for %s: %v", req.UserID, readErr)
				// stop forwarding on read errors
				break
			}
			if _, writeErr := localTrack.Write(buf[:n]); writeErr != nil {
				log.Printf("[SFU] RTP write error for %s: %v", req.UserID, writeErr)
				break
			}
		}

		// If we exit read loop, cleanup localTrack from other peers
		removePublishedTrack(req.UserID, localTrack)
	})

	// Add transceiver for audio (we want to receive audio)
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio); err != nil {
		log.Printf("[SFU] Failed to add transceiver: %v", err)
		// continue anyway
	}

	// Store peerCtx
	mapLock.Lock()
	peers[req.UserID] = peerCtx
	mapLock.Unlock()

	// Add existing tracks from other peers to the new peer (so new joiner receives already-published audio)
	mapLock.RLock()
	for otherID, otherPeer := range peers {
		if otherID == req.UserID {
			continue
		}
		if otherPeer.ProjectID != req.ProjectID {
			continue
		}
		otherPeer.lock.Lock()
		for _, t := range otherPeer.Tracks {
			if sender, err := pc.AddTrack(t); err != nil {
				log.Printf("[SFU] Failed to add existing track for new peer %s: %v", req.UserID, err)
			} else {
				peerCtx.Senders = append(peerCtx.Senders, sender)
			}
		}
		otherPeer.lock.Unlock()
	}
	mapLock.RUnlock()

	// Create Offer and send it to hub to be forwarded to the client
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

	// send via writer channel
	writeCh <- msg
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
	log.Printf("[SFU] Disconnecting user %s", req.UserID)

	// Remove peer from map
	mapLock.Lock()
	peer, ok := peers[req.UserID]
	if !ok {
		mapLock.Unlock()
		return
	}
	delete(peers, req.UserID)
	mapLock.Unlock()

	peer.lock.Lock()

	// Remove all senders (detaches tracks so RTP read stops)
	for _, sender := range peer.PeerConnection.GetSenders() {
		if err := peer.PeerConnection.RemoveTrack(sender); err != nil {
			log.Printf("[SFU] Error removing sender: %v", err)
		}
	}

	// Close peer connection
	if err := peer.PeerConnection.Close(); err != nil {
		log.Printf("[SFU] Error closing peer: %v", err)
	}
	peer.lock.Unlock()

	// Remove published tracks from other peers
	removeAllPublisherTracks(req.UserID)
}


func removeAllPublisherTracks(publisherID string) {
	mapLock.RLock()
	defer mapLock.RUnlock()
	for otherID, otherPeer := range peers {
		otherPeer.lock.Lock()
		// iterate senders and remove senders that reference publisher's stream (we used naming with publisherID)
		newSenders := otherPeer.Senders[:0]
		for _, s := range otherPeer.Senders {
			if s == nil {
				continue
			}
			track := s.Track()
			if track == nil {
				// keep it (or drop?); to be safe, keep
				newSenders = append(newSenders, s)
				continue
			}
			// publisher ID is encoded in track ID or streamID per our naming scheme
			if containsPublisherID(track.ID(), publisherID) || containsPublisherID(track.StreamID(), publisherID) {
				if err := otherPeer.PeerConnection.RemoveTrack(s); err != nil {
					log.Printf("[SFU] RemoveTrack error for peer %s: %v", otherID, err)
				} else {
					log.Printf("[SFU] Removed track from peer %s for publisher %s", otherID, publisherID)
				}
			} else {
				newSenders = append(newSenders, s)
			}
		}
		otherPeer.Senders = newSenders
		otherPeer.lock.Unlock()
	}
}

func removePublishedTrack(publisherID string, localTrack *webrtc.TrackLocalStaticRTP) {
	// Remove a single published track from all others (used when a remote track ends)
	mapLock.RLock()
	defer mapLock.RUnlock()
	for otherID, otherPeer := range peers {
		otherPeer.lock.Lock()
		newSenders := otherPeer.Senders[:0]
		for _, s := range otherPeer.Senders {
			if s == nil {
				continue
			}
			if s.Track() == nil {
				newSenders = append(newSenders, s)
				continue
			}
			// compare by track ID/streamID or by pointer equality to localTrack (the library doesn't export direct equality)
			t := s.Track()
			if t != nil && (t.ID() == localTrack.ID() || t.StreamID() == localTrack.StreamID()) {
				if err := otherPeer.PeerConnection.RemoveTrack(s); err != nil {
					log.Printf("[SFU] RemoveTrack error for peer %s: %v", otherID, err)
				} else {
					log.Printf("[SFU] Removed finished track from peer %s (publisher %s)", otherID, publisherID)
				}
			} else {
				newSenders = append(newSenders, s)
			}
		}
		otherPeer.Senders = newSenders
		otherPeer.lock.Unlock()
	}
}

// helper: check if a track id or stream id contains publisherID substring
func containsPublisherID(s, publisherID string) bool {
	if s == "" || publisherID == "" {
		return false
	}
	// We used naming remoteTrack.ID()+"-"+publisherID so substring check is valid
	return (len(s) >= len(publisherID) && (s == publisherID || (len(s) > len(publisherID) && (stringContains(s, publisherID)))))
}

// micro-optimized strings.Contains replacement (avoids import cycle in tiny code)
func stringContains(s, sub string) bool {
	return len(sub) <= len(s) && (indexOf(s, sub) >= 0)
}

// naive indexOf (sufficient for small strings)
func indexOf(s, sub string) int {
	if sub == "" {
		return 0
	}
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
