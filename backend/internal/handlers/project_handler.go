// in handlers/project_handler.go
package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"project-meetings/backend/internal/database"
	"project-meetings/backend/internal/middleware"
	"project-meetings/backend/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func GetUserRoleForProject(w http.ResponseWriter, r *http.Request) {
	userIDStr, _ := r.Context().Value(middleware.UserIDKey).(string)
	projectIDStr := chi.URLParam(r, "projectId")

	var role string
	query := `SELECT role FROM project_members WHERE user_id = $1 AND project_id = $2`
	err := database.DB.QueryRow(context.Background(), query, userIDStr, projectIDStr).Scan(&role)
	if err != nil {
		// This shouldn't happen if RBAC middleware is working, but it's good practice
		http.Error(w, "Could not find role for user in project", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"role": role})
}

// --- RENAME PROJECT ---
func RenameProject(w http.ResponseWriter, r *http.Request) {
	projectIDStr := chi.URLParam(r, "projectId")

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		http.Error(w, "Project name cannot be empty", http.StatusBadRequest)
		return
	}

	query := `UPDATE projects SET name = $1, updated_at = NOW() WHERE id = $2`
	_, err := database.DB.Exec(context.Background(), query, req.Name, projectIDStr)
	if err != nil {
		log.Printf("Failed to rename project: %v", err)
		http.Error(w, "Failed to rename project", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// --- DELETE PROJECT ---
func DeleteProject(w http.ResponseWriter, r *http.Request) {
	projectIDStr := chi.URLParam(r, "projectId")

	// The `ON DELETE CASCADE` in our database schema will handle cleaning up
	// project_members, files, whiteboard_shapes, and invites automatically.
	query := `DELETE FROM projects WHERE id = $1`
	_, err := database.DB.Exec(context.Background(), query, projectIDStr)
	if err != nil {
		log.Printf("Failed to delete project: %v", err)
		http.Error(w, "Failed to delete project", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent) // 204 is standard for successful deletion
}

// --- GET PROJECT MEMBERS ---
// We need a struct to hold the combined user/member info
type ProjectMemberInfo struct {
	UserID   uuid.UUID `json:"userId"`
	Username string    `json:"username"`
	Email    string    `json:"email"`
	Role     string    `json:"role"`
}

func GetProjectMembers(w http.ResponseWriter, r *http.Request) {
	projectIDStr := chi.URLParam(r, "projectId")

	query := `
		SELECT u.id, u.username, u.email, pm.role
		FROM project_members pm
		JOIN users u ON pm.user_id = u.id
		WHERE pm.project_id = $1
		ORDER BY u.username
	`
	rows, err := database.DB.Query(context.Background(), query, projectIDStr)
	if err != nil {
		log.Printf("Failed to get project members: %v", err)
		http.Error(w, "Failed to retrieve project members", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var members []ProjectMemberInfo
	for rows.Next() {
		var member ProjectMemberInfo
		if err := rows.Scan(&member.UserID, &member.Username, &member.Email, &member.Role); err != nil {
			log.Printf("Failed to scan project member: %v", err)
			http.Error(w, "Error processing member list", http.StatusInternalServerError)
			return
		}
		members = append(members, member)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(members)
}

// --- UPDATE MEMBER ROLE ---
func UpdateMemberRole(hub *ws.Hub, w http.ResponseWriter, r *http.Request) {
	projectIDStr := chi.URLParam(r, "projectId")
	memberIDStr := chi.URLParam(r, "memberId")

	var req struct {
		Role string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Validate the role to prevent arbitrary strings
	if req.Role != "editor" && req.Role != "viewer" {
		http.Error(w, "Invalid role. Must be 'editor' or 'viewer'.", http.StatusBadRequest)
		return
	}

	// Prevent the owner from changing their own role
	ownerIDStr, _ := r.Context().Value(middleware.UserIDKey).(string)
	if ownerIDStr == memberIDStr {
		http.Error(w, "Project owner's role cannot be changed.", http.StatusBadRequest)
		return
	}

	query := `UPDATE project_members SET role = $1 WHERE project_id = $2 AND user_id = $3`
	_, err := database.DB.Exec(context.Background(), query, req.Role, projectIDStr, memberIDStr)
	if err != nil {
		log.Printf("Failed to update member role: %v", err)
		http.Error(w, "Failed to update member role", http.StatusInternalServerError)
		return
	}

	if targetClient, ok := hub.UserMap[memberIDStr]; ok {
		log.Printf("[API] Notifying user %s of role change to %s", targetClient.Username, req.Role)
		payload, _ := json.Marshal(map[string]string{"newRole": req.Role})
		msg, _ := json.Marshal(ws.WsMessage{Type: "permission_updated", Payload: payload})
		targetClient.Send <- msg
	}

	w.WriteHeader(http.StatusOK)
}

// --- REMOVE PROJECT MEMBER ---
func RemoveProjectMember(hub *ws.Hub, w http.ResponseWriter, r *http.Request) {
	projectIDStr := chi.URLParam(r, "projectId")
	memberIDStr := chi.URLParam(r, "memberId")

	// Prevent the owner from removing themselves
	ownerIDStr, _ := r.Context().Value(middleware.UserIDKey).(string)
	if ownerIDStr == memberIDStr {
		http.Error(w, "Project owner cannot be removed from the project.", http.StatusBadRequest)
		return
	}

	query := `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`
	_, err := database.DB.Exec(context.Background(), query, projectIDStr, memberIDStr)
	if err != nil {
		log.Printf("Failed to remove project member: %v", err)
		http.Error(w, "Failed to remove member", http.StatusInternalServerError)
		return
	}
	if targetClient, ok := hub.UserMap[memberIDStr]; ok {
		log.Printf("[API] Notifying user %s they have been removed from the project", targetClient.Username)
		payload, _ := json.Marshal(map[string]string{"reason": "You have been removed from this project by the owner."})
		msg, _ := json.Marshal(ws.WsMessage{Type: "force_disconnect", Payload: payload})

		// Send the message and then immediately unregister them from the hub
		targetClient.Send <- msg
		hub.Unregister <- targetClient
	}

	w.WriteHeader(http.StatusNoContent)
}
