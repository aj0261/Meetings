package ws

import (
	"context"
	"encoding/json"
	"log"
	"project-meetings/backend/internal/database"

	"github.com/jackc/pgx/v5/pgtype"
)

type WsMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type Message struct {
	ProjectID string
	Data      []byte
	Sender    *Client
}

type UserPresence struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
}

type ProjectState struct {
	EditorContents   map[string]string
	WhiteboardShapes map[string]string
}

type SignalPayload struct {
	Target string          `json:"target"`
	Sender string          `json:"sender"`
	Data   json.RawMessage `json:"data"`
}

type ICEBuffer struct {
	Candidates   [][]byte
	PendingOffer []byte
	OfferSent    bool
	AnswerSent   bool
}

type Hub struct {
	Clients       map[string]map[string]*Client // projectID -> userID -> Client
	UserMap       map[string]*Client            // userID -> Client
	Broadcast     chan *Message
	Register      chan *Client
	Unregister    chan *Client
	sfuMessages   chan []byte
	ProjectStates map[string]*ProjectState
	sfuClient     *Client
	iceBuffers    map[string]*ICEBuffer
}

func NewHub() *Hub {
	return &Hub{
		Broadcast:     make(chan *Message),
		Register:      make(chan *Client),
		Unregister:    make(chan *Client),
		sfuMessages:   make(chan []byte, 256),
		Clients:       make(map[string]map[string]*Client),
		UserMap:       make(map[string]*Client),
		ProjectStates: make(map[string]*ProjectState),
		iceBuffers:    make(map[string]*ICEBuffer),
	}
}

func (h *Hub) broadcastPresence(projectID string) {
	if clientsInRoom, ok := h.Clients[projectID]; ok {
		var presenceInfo []UserPresence
		for _, client := range clientsInRoom {
			presenceInfo = append(presenceInfo, UserPresence{
				UserID:   client.UserID,
				Username: client.Username,
			})
		}
		payloadBytes, _ := json.Marshal(map[string]interface{}{"users": presenceInfo})
		message := WsMessage{
			Type:    "presence_update",
			Payload: payloadBytes,
		}
		jsonMessage, _ := json.Marshal(message)
		for _, client := range clientsInRoom {
			select {
			case client.Send <- jsonMessage:
			default:
			}
		}
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.Register:
			if client.ProjectID == "sfu-internal-channel" {
				if h.sfuClient != nil {
					log.Println("[Hub] New SFU connected, closing old SFU connection")
					h.sfuClient.Conn.Close()
				}
				h.sfuClient = client
				log.Println("[Hub] SFU Server connected")
				continue
			}
			if _, ok := h.Clients[client.ProjectID]; !ok {
				h.Clients[client.ProjectID] = make(map[string]*Client)
			}
			if oldClient, ok := h.UserMap[client.UserID]; ok {
				log.Printf("[Hub] User %s reconnecting, closing old channel", oldClient.UserID)
				close(oldClient.Send)
			}
			h.Clients[client.ProjectID][client.UserID] = client
			h.UserMap[client.UserID] = client
			log.Printf("[Hub] Client %s registered to project %s", client.Username, client.ProjectID)
			h.broadcastPresence(client.ProjectID)

		case client := <-h.Unregister:
			if h.sfuClient == client {
				h.sfuClient = nil
				log.Println("[Hub] SFU Server disconnected")
				continue
			}
			if room, ok := h.Clients[client.ProjectID]; ok {
				if C, ok := room[client.UserID]; ok && C == client {
					delete(room, client.UserID)
					close(client.Send)
					delete(h.UserMap, client.UserID)
					log.Printf("[Hub] Client %s left project %s", client.Username, client.ProjectID)
					if h.sfuClient != nil {
						disconnectPayload, _ := json.Marshal(map[string]string{"userId": client.UserID})
						msg, _ := json.Marshal(WsMessage{Type: "webrtc_disconnect", Payload: disconnectPayload})
						h.sfuClient.Send <- msg
					}
				}
				if len(room) == 0 {
					delete(h.Clients, client.ProjectID)
				} else {
					h.broadcastPresence(client.ProjectID)
				}
			}

			// In Run()
		case messageData := <-h.sfuMessages:
			var msg WsMessage
			if err := json.Unmarshal(messageData, &msg); err != nil {
				log.Printf("[Hub] Error unmarshalling SFU message: %v", err)
				continue
			}

			var payload SignalPayload
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				log.Printf("[Hub] Error unmarshalling SFU payload: %v", err)
				continue
			}

			switch msg.Type {
			case "webrtc_offer":
				h.ensureICEBuffer(payload.Target)
				if targetClient, ok := h.UserMap[payload.Target]; ok {
					// User is online → send immediately
					log.Printf("[Hub] Forwarding OFFER to %s", payload.Target)
					h.iceBuffers[payload.Target].OfferSent = true
					targetClient.Send <- messageData
					h.flushICE(payload.Target, targetClient)
				} else {
					// User not yet connected → buffer offer
					log.Printf("[Hub] Buffering OFFER for %s until they join", payload.Target)
					h.iceBuffers[payload.Target].PendingOffer = messageData
				}

			case "webrtc_ice_candidate":
				h.ensureICEBuffer(payload.Target)
				if targetClient, ok := h.UserMap[payload.Target]; ok {
					log.Printf("[Hub] Forwarding ICE candidate to %s", payload.Target)
					if !h.iceBuffers[payload.Target].OfferSent && !h.iceBuffers[payload.Target].AnswerSent {
						log.Printf("[Hub] Buffering ICE candidate for %s until offer/answer", payload.Target)
						h.iceBuffers[payload.Target].Candidates = append(h.iceBuffers[payload.Target].Candidates, payload.Data)
					} else {
						targetClient.Send <- messageData
					}
				} else {
					// User not connected yet → buffer ICE
					log.Printf("[Hub] Buffering ICE candidate for %s (not connected)", payload.Target)
					h.iceBuffers[payload.Target].Candidates = append(h.iceBuffers[payload.Target].Candidates, payload.Data)
				}

			default:
				if targetClient, ok := h.UserMap[payload.Target]; ok {
					targetClient.Send <- messageData
				}
			}

		case message := <-h.Broadcast:
			var msg WsMessage
			if err := json.Unmarshal(message.Data, &msg); err != nil {
				log.Printf("[Hub] Error unmarshalling message: %v", err)
				continue
			}
			switch msg.Type {
			case "webrtc_join":
				log.Printf("[Hub] %s requested to join WebRTC in project %s", message.Sender.UserID, message.ProjectID)
				if h.sfuClient == nil {
					log.Println("[Hub] No SFU available, cannot join")
					continue
				}
				connectPayload, _ := json.Marshal(map[string]string{
					"userId":    message.Sender.UserID,
					"projectId": message.Sender.ProjectID,
				})
				h.ensureICEBuffer(message.Sender.UserID)
				if len(h.iceBuffers[message.Sender.UserID].PendingOffer) > 0 {
					log.Printf("[Hub] Sending buffered OFFER to %s", message.Sender.UserID)
					message.Sender.Send <- h.iceBuffers[message.Sender.UserID].PendingOffer
					h.iceBuffers[message.Sender.UserID].OfferSent = true
					h.iceBuffers[message.Sender.UserID].PendingOffer = nil
					h.flushICE(message.Sender.UserID, message.Sender)
				}
				sfuMsg, _ := json.Marshal(WsMessage{Type: "webrtc_connect_request", Payload: connectPayload})
				h.sfuClient.Send <- sfuMsg
				log.Printf("[Hub] Sent connect request to SFU for %s", message.Sender.UserID)

			case "webrtc_answer":
				if h.sfuClient == nil {
					continue
				}
				var payload SignalPayload
				json.Unmarshal(msg.Payload, &payload)
				h.ensureICEBuffer(payload.Sender)
				h.iceBuffers[payload.Sender].AnswerSent = true
				sfuPayload, _ := json.Marshal(SignalPayload{Sender: message.Sender.UserID, Data: payload.Data})
				finalMsg, _ := json.Marshal(WsMessage{Type: "webrtc_answer", Payload: sfuPayload})
				h.sfuClient.Send <- finalMsg
				h.flushICE(payload.Sender, nil)
				log.Printf("[Hub] Forwarded ANSWER from %s to SFU", payload.Sender)

			case "webrtc_ice_candidate":
				if h.sfuClient == nil {
					continue
				}
				var payload SignalPayload
				json.Unmarshal(msg.Payload, &payload)
				h.ensureICEBuffer(payload.Sender)
				if !h.iceBuffers[payload.Sender].OfferSent && !h.iceBuffers[payload.Sender].AnswerSent {
					h.iceBuffers[payload.Sender].Candidates = append(h.iceBuffers[payload.Sender].Candidates, payload.Data)
				} else {
					sfuPayload, _ := json.Marshal(SignalPayload{Sender: message.Sender.UserID, Data: payload.Data})
					finalMsg, _ := json.Marshal(WsMessage{Type: "webrtc_ice_candidate", Payload: sfuPayload})
					h.sfuClient.Send <- finalMsg
				}

			default:
				if _, ok := h.ProjectStates[message.ProjectID]; !ok {
					h.ProjectStates[message.ProjectID] = &ProjectState{
						EditorContents:   make(map[string]string),
						WhiteboardShapes: make(map[string]string),
					}
				}
				projectState := h.ProjectStates[message.ProjectID]
				shouldBroadcast := true
				switch msg.Type {
				case "request_file_content":
					shouldBroadcast = false
					var payload map[string]string
					if err := json.Unmarshal(msg.Payload, &payload); err == nil {
						if fileID, ok := payload["fileId"]; ok {

							var contentToSend string

							// First, check if we have a "live" version in our in-memory map.
							content, contentExists := projectState.EditorContents[fileID]

							if contentExists {
								// --- HOT PATH ---
								// The file is active. Serve the latest version from memory.
								contentToSend = content
							} else {
								// --- COLD PATH ---
								// No one has touched this file since the server started.
								// Load it from the database for the first time.
								log.Printf("No in-memory version for file %s. Loading from DB.", fileID)
								var dbContent pgtype.Text
								query := `SELECT content FROM files WHERE id = $1`
								err := database.DB.QueryRow(context.Background(), query, fileID).Scan(&dbContent)
								if err != nil {
									log.Printf("Failed to query file content for %s: %v", fileID, err)
									contentToSend = "// File content could not be loaded."
								} else {
									contentToSend = dbContent.String
								}
								// Store it in memory for the next person who asks.
								projectState.EditorContents[fileID] = contentToSend
							}

							// Send the definitive content to the requester.
							responsePayload, _ := json.Marshal(map[string]string{"fileId": fileID, "content": contentToSend})
							response := WsMessage{Type: "editor_update", Payload: responsePayload}
							jsonMsg, _ := json.Marshal(response)
							message.Sender.Send <- jsonMsg
						}
					}
				case "editor_update":
					var payload map[string]string
					if err := json.Unmarshal(msg.Payload, &payload); err == nil {
						if fileID, ok := payload["fileId"]; ok {
							projectState.EditorContents[fileID] = payload["content"]
						}
					}
				case "whiteboard_update":
					var payload map[string]json.RawMessage
					if err := json.Unmarshal(msg.Payload, &payload); err == nil {
						if shapeData, ok := payload["shape"]; ok {
							var shape map[string]interface{}
							if err := json.Unmarshal(shapeData, &shape); err == nil {
								if shapeID, ok := shape["id"].(string); ok {
									// 1. Update in-memory state for live broadcast
									projectState.WhiteboardShapes[shapeID] = string(shapeData)
									// 2. NEW: Persist to the database (UPSERT logic)
									query := `
                            INSERT INTO whiteboard_shapes (id, project_id, shape_data, updated_at)
                            VALUES ($1, $2, $3, NOW())
                            ON CONFLICT (id, project_id) DO UPDATE SET
                            shape_data = EXCLUDED.shape_data,
                            updated_at = NOW();
                        `
									_, err := database.DB.Exec(context.Background(), query, shapeID, message.ProjectID, shapeData)
									if err != nil {
										log.Printf("Failed to save whiteboard shape: %v", err)
									}
									projectState.WhiteboardShapes[shapeID] = string(shapeData)
								}
							}
						}
					}
				case "whiteboard_object_remove":
					var payload map[string]string
					if err := json.Unmarshal(msg.Payload, &payload); err == nil {
						if shapeID, ok := payload["id"]; ok {
							// 1. Remove from in-memory state
							delete(projectState.WhiteboardShapes, shapeID)

							// 2. NEW: Delete from the database
							query := `DELETE FROM whiteboard_shapes WHERE id = $1 AND project_id = $2`
							_, err := database.DB.Exec(context.Background(), query, shapeID, message.ProjectID)
							if err != nil {
								log.Printf("Failed to delete whiteboard shape: %v", err)
							}
						}
					}
				case "file_created", "file_deleted", "file_renamed":
					// These are just notifications for other clients. We don't need to store
					// any state for them here, just let them be broadcast.
				}
				if shouldBroadcast {
					if clientsInRoom, ok := h.Clients[message.ProjectID]; ok {
						for _, client := range clientsInRoom {
							if client != message.Sender {
								select {
								case client.Send <- message.Data:
								default:
									close(client.Send)
									delete(h.Clients[message.ProjectID], client.UserID)
									delete(h.UserMap, client.UserID)
								}
							}
						}
					}
				}
			}
		}
	}
}

func (h *Hub) ensureICEBuffer(userID string) {
	if _, ok := h.iceBuffers[userID]; !ok {
		h.iceBuffers[userID] = &ICEBuffer{Candidates: [][]byte{}}
	}
}

func (h *Hub) flushICE(userID string, target *Client) {
	if buf, ok := h.iceBuffers[userID]; ok {
		log.Printf("[Hub] Flushing %d buffered ICE candidates for %s", len(buf.Candidates), userID)
		for _, ice := range buf.Candidates {
			signalPayload := SignalPayload{Target: userID, Sender: "sfu", Data: ice}
			payloadBytes, _ := json.Marshal(signalPayload)
			msg, _ := json.Marshal(WsMessage{Type: "webrtc_ice_candidate", Payload: payloadBytes})
			if target != nil {
				target.Send <- msg
			} else if c, ok := h.UserMap[userID]; ok {
				c.Send <- msg
			}
		}
		buf.Candidates = nil
	}
}
