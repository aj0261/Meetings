package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"project-meetings/backend/internal/database"
	"project-meetings/backend/internal/middleware"
	"project-meetings/backend/internal/models"
	"project-meetings/backend/internal/ws"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
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

	// 1. Always ensure the top-level project state exists in the hub map.
	// This makes it safe to access state.WhiteboardShapes later.
	// This is thread-safe enough for our purposes without a mutex because
	// even if two requests create it, they'll just overwrite with the same empty struct.
	if _, ok := hub.ProjectStates[projectId]; !ok {
		log.Printf("[API] Initializing in-memory state for project %s via GetWhiteboardState.", projectId)
		hub.ProjectStates[projectId] = &ws.ProjectState{
			EditorContents:   make(map[string]string),
			WhiteboardShapes: make(map[string]string),
		}
	}

	state := hub.ProjectStates[projectId]

	// 2. Check if the in-memory shape cache has been populated yet.
	// If its length is 0, it means this is the first time anyone has asked for
	// the whiteboard since the server started. This is our trigger to load from the DB.
	if len(state.WhiteboardShapes) == 0 {
		log.Printf("[API] In-memory whiteboard for %s is empty. Loading from DB.", projectId)
		
		query := `SELECT id, shape_data FROM whiteboard_shapes WHERE project_id = $1`
		rows, err := database.DB.Query(context.Background(), query, projectId)
		if err != nil {
			log.Printf("[API] Failed to load whiteboard state from DB: %v", err)
			http.Error(w, "Failed to load whiteboard state", http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		shapeCount := 0
		for rows.Next() {
			var id string
			var shapeData []byte
			if err := rows.Scan(&id, &shapeData); err != nil {
				http.Error(w, "Failed to scan shape data", http.StatusInternalServerError)
				return
			}
			// Populate the in-memory map (the cache) with data from the database.
			state.WhiteboardShapes[id] = string(shapeData)
			shapeCount++
		}
		log.Printf("[API] Loaded %d shapes from DB into memory for project %s.", shapeCount, projectId)
	} else {
		log.Printf("[API] Serving whiteboard for %s from in-memory cache.", projectId)
	}

	// 3. Now, serve the shapes from the (potentially newly populated) in-memory map.
	shapeMap := state.WhiteboardShapes
	shapes := make([]json.RawMessage, 0, len(shapeMap))
	for _, shapeJSON := range shapeMap {
		shapes = append(shapes, json.RawMessage(shapeJSON))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string][]json.RawMessage{"shapes": shapes})
}
// Helper function to generate a secure random string for the invite code
func generateInviteCode(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}


func CreateProjectInvite(w http.ResponseWriter, r *http.Request) {
    // --- Authentication and Authorization ---
	userID, ok := r.Context().Value(middleware.UserIDKey).(string)
	if !ok {
		http.Error(w, "Could not retrieve user ID from context", http.StatusInternalServerError)
		return
	}

	projectIDStr := chi.URLParam(r, "projectId")
	projectID, err := uuid.Parse(projectIDStr)
	if err != nil {
		http.Error(w, "Invalid project ID", http.StatusBadRequest)
		return
	}

    // --- Check if the user is the owner (this is our first use of RBAC!) ---
    var ownerID uuid.UUID
    query := `SELECT owner_id FROM projects WHERE id = $1`
    err = database.DB.QueryRow(context.Background(), query, projectID).Scan(&ownerID)
    if err != nil {
        http.Error(w, "Project not found", http.StatusNotFound)
        return
    }

    if ownerID.String() != userID {
        http.Error(w, "Only the project owner can create invites", http.StatusForbidden)
        return
    }

    // --- Generate Invite Code ---
    inviteCode, err := generateInviteCode(8) // Creates a 16-character hex string
    if err != nil {
        http.Error(w, "Failed to generate invite code", http.StatusInternalServerError)
        return
    }
    
    // Invites expire in 24 hours
    expiresAt := time.Now().Add(24 * time.Hour)

    // --- Save to Database ---
    insertQuery := `INSERT INTO project_invites (project_id, code, created_by, expires_at) VALUES ($1, $2, $3, $4) RETURNING code, expires_at`
    var createdCode string
    var createdExpiresAt time.Time

    err = database.DB.QueryRow(context.Background(), insertQuery, projectID, inviteCode, userID, expiresAt).Scan(&createdCode, &createdExpiresAt)
    if err != nil {
        log.Printf("Failed to create invite: %v", err)
        http.Error(w, "Failed to create invite", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "inviteCode": createdCode,
        "expiresAt": createdExpiresAt,
    })
}

func AcceptProjectInvite(w http.ResponseWriter, r *http.Request) {
    userID, ok := r.Context().Value(middleware.UserIDKey).(string)
	if !ok {
		http.Error(w, "Could not retrieve user ID from context", http.StatusInternalServerError)
		return
	}

    var req struct {
        InviteCode string `json:"inviteCode"`
    }

    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

    // --- Find the invite and its associated project ---
    var projectID uuid.UUID
    var expiresAt time.Time
    
    findQuery := `SELECT project_id, expires_at FROM project_invites WHERE code = $1 AND is_used = FALSE`
    err := database.DB.QueryRow(context.Background(), findQuery, req.InviteCode).Scan(&projectID, &expiresAt)
    if err != nil {
        http.Error(w, "Invite code is invalid or has already been used", http.StatusNotFound)
        return
    }

    if time.Now().After(expiresAt) {
        http.Error(w, "Invite code has expired", http.StatusBadRequest)
        return
    }

    // --- Add user to the project as a member ---
    // The role 'editor' is the default from our schema.
    // ON CONFLICT DO NOTHING prevents an error if the user is already a member.
    addMemberQuery := `
        INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')
        ON CONFLICT (project_id, user_id) DO NOTHING
    `
    _, err = database.DB.Exec(context.Background(), addMemberQuery, projectID, userID)
    if err != nil {
        http.Error(w, "Failed to add user to project", http.StatusInternalServerError)
        return
    }

    // --- Mark the invite as used (or delete it for single-use) ---
    // Deleting is simpler and cleaner for true single-use invites.
    deleteQuery := `DELETE FROM project_invites WHERE code = $1`
    _, err = database.DB.Exec(context.Background(), deleteQuery, req.InviteCode)
    if err != nil {
        log.Printf("Warning: failed to delete used invite code %s: %v", req.InviteCode, err)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "message": "Successfully joined project!",
        "projectId": projectID,
    })
}