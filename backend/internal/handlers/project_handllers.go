package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"project-meetings/backend/internal/database"
	"project-meetings/backend/internal/middleware"
	"project-meetings/backend/internal/models"
	"project-meetings/backend/internal/ws"

	"github.com/go-chi/chi/v5"
)

// CreateProject handles the creation of a new project.
func CreateProject(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(middleware.UserIDKey).(string)
	if !ok {
		http.Error(w, "Could not retrieve user ID from context", http.StatusInternalServerError)
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		http.Error(w, "Project name is required", http.StatusBadRequest)
		return
	}

	var newProject models.Project

	tx, err := database.DB.Begin(context.Background())
	if err != nil {
		http.Error(w, "Failed to start transaction", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(context.Background())

	projectQuery := `INSERT INTO projects (name, owner_id) VALUES ($1, $2) RETURNING id, owner_id, name, created_at, updated_at`
	err = tx.QueryRow(context.Background(), projectQuery, req.Name, userID).Scan(&newProject.ID, &newProject.OwnerID, &newProject.Name, &newProject.CreatedAt, &newProject.UpdatedAt)
	if err != nil {
		log.Printf("Failed to insert project: %v", err)
		http.Error(w, "Failed to create project", http.StatusInternalServerError)
		return
	}

	memberQuery := `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`
	_, err = tx.Exec(context.Background(), memberQuery, newProject.ID, userID)
	if err != nil {
		log.Printf("Failed to add owner to project members: %v", err)
		http.Error(w, "Failed to create project", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(context.Background()); err != nil {
		http.Error(w, "Failed to commit transaction", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(newProject)
}

// GetUserProjects handles listing all projects a user is a member of.
func GetUserProjects(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(middleware.UserIDKey).(string)
	if !ok {
		http.Error(w, "Could not retrieve user ID from context", http.StatusInternalServerError)
		return
	}
	query := `
		SELECT p.id, p.owner_id, p.name, p.created_at, p.updated_at
		FROM projects p
		JOIN project_members pm ON p.id = pm.project_id
		WHERE pm.user_id = $1
		ORDER BY p.created_at DESC`

	rows, err := database.DB.Query(context.Background(), query, userID)
	if err != nil {
		log.Printf("Failed to query projects: %v", err)
		http.Error(w, "Failed to retrieve projects", http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	projects := make([]models.Project, 0)
	for rows.Next() {
		var p models.Project
		if err := rows.Scan(&p.ID, &p.OwnerID, &p.Name, &p.CreatedAt, &p.UpdatedAt); err != nil {
			http.Error(w, "Failed to scan project row", http.StatusInternalServerError)
			return
		}
		projects = append(projects, p)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(projects)
}


// GetWhiteboardState retrieves the current in-memory state of the whiteboard for a project.
func GetWhiteboardState(hub *ws.Hub, w http.ResponseWriter, r *http.Request) {
	projectId := chi.URLParam(r, "projectId")

	if _, ok := hub.ProjectStates[projectId]; !ok {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string][]json.RawMessage{"shapes": {}})
		return
	}

	shapeMap := hub.ProjectStates[projectId].WhiteboardShapes
	if shapeMap == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string][]json.RawMessage{"shapes": {}})
		return
    }

	shapes := make([]json.RawMessage, 0, len(shapeMap))
	for _, shapeJSON := range shapeMap {
		shapes = append(shapes, json.RawMessage(shapeJSON))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string][]json.RawMessage{"shapes": shapes})
}