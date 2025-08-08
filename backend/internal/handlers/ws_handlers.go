package handlers

import (
	"log"
	"net/http"

	"project-meetings/backend/internal/auth" // Import the auth package
	"project-meetings/backend/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func ServeWs(hub *ws.Hub, w http.ResponseWriter, r *http.Request) {
	projectId := chi.URLParam(r, "projectId")
	if projectId == "" {
		http.Error(w, "Project ID is required in URL", http.StatusBadRequest)
		return
	}

	var userId string
	var username string

	if projectId == "sfu-internal-channel" {
		log.Println("Internal SFU client is connecting. Bypassing user auth.")
		userId = "sfu"
		username = "SFU Server"
	} else {
		tokenStr := r.URL.Query().Get("auth_token")
		if tokenStr == "" {
			http.Error(w, "Missing auth_token query parameter", http.StatusUnauthorized)
			return
		}

		// This call will now succeed because the function exists in the auth package.
		claims, err := auth.ValidateJWTAndGetClaims(tokenStr)
		if err != nil {
			http.Error(w, "Invalid auth token", http.StatusUnauthorized)
			return
		}
		
		userId = claims.UserID
		username = claims.Username
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Failed to upgrade WebSocket connection:", err)
		return
	}

	client := &ws.Client{
		Hub:       hub,
		Conn:      conn,
		Send:      make(chan []byte, 256),
		ProjectID: projectId,
		UserID:    userId,
		Username:  username,
	}
	client.Hub.Register <- client

	go client.WritePump()
	go client.ReadPump()
}