package handlers

import (
	"context"
	"log"
	"net/http"
	"project-meetings/backend/internal/auth" // Import the auth package
	"project-meetings/backend/internal/database"
	"project-meetings/backend/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5"
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

	var userIdStr string // Changed name for clarity
	var username string

	if projectId == "sfu-internal-channel" {
		log.Println("Internal SFU client is connecting. Bypassing user auth.")
		userIdStr = "sfu"
		username = "SFU Server"
	} else {
		tokenStr := r.URL.Query().Get("auth_token")
		if tokenStr == "" {
			http.Error(w, "Missing auth_token query parameter", http.StatusUnauthorized)
			return
		}

		claims, err := auth.ValidateJWTAndGetClaims(tokenStr)
		if err != nil {
			http.Error(w, "Invalid auth token", http.StatusUnauthorized)
			return
		}
		
		userIdStr = claims.UserID
		username = claims.Username
	}
	
	// --- START OF FIX ---
	var userRole string

	if projectId == "sfu-internal-channel" {
		userRole = "sfu"
	} else {
		// 1. Parse both project and user IDs into proper UUID types
		projectUUID, err := uuid.Parse(projectId)
		if err != nil {
			 http.Error(w, "Invalid Project ID format", http.StatusBadRequest)
			 return
		}
		userUUID, err := uuid.Parse(userIdStr)
		if err != nil {
			 http.Error(w, "Invalid User ID format in token", http.StatusInternalServerError)
			 return
		}

		// 2. Execute the query with the correct UUID types
		query := `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`
		err = database.DB.QueryRow(context.Background(), query, projectUUID, userUUID).Scan(&userRole)
		
		// 3. Handle the error properly
		if err != nil {
			if err == pgx.ErrNoRows {
				log.Printf("WebSocket connection denied for user %s in project %s: not a member.", username, projectId)
				http.Error(w, "Forbidden: You are not a member of this project", http.StatusForbidden)
			} else {
				log.Printf("Database error verifying membership for user %s: %v", username, err)
				http.Error(w, "Failed to verify project membership", http.StatusInternalServerError)
			}
			return // IMPORTANT: We must stop execution if the role cannot be found.
		}
	}
	// --- END OF FIX ---


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
		UserID:    userIdStr, // Keep the string version for the client struct
		Username:  username,
		Role:      userRole, // Now this will have the correct role ('owner', 'editor', etc.)
	}
	client.Hub.Register <- client

	go client.WritePump()
	go client.ReadPump()

}