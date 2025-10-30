// backend/internal/middleware/rbac.go
package middleware

import (
	"context"
	"net/http"
	"project-meetings/backend/internal/database"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ProjectMemberAuth is a middleware that checks if a user is a member of a project
// with at least one of the required roles.
func ProjectMemberAuth(requiredRoles ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userIDStr, ok := r.Context().Value(UserIDKey).(string)
			if !ok {
				http.Error(w, "Could not retrieve user ID from context", http.StatusInternalServerError)
				return
			}
			userID, _ := uuid.Parse(userIDStr)

			var projectID uuid.UUID
			var err error

			// Determine how to get the project ID from the URL
			projectIDStr := chi.URLParam(r, "projectId")
			if projectIDStr != "" {
				projectID, err = uuid.Parse(projectIDStr)
				if err != nil {
					http.Error(w, "Invalid project ID format", http.StatusBadRequest)
					return
				}
			} else {
				// If no projectId, try to get it from a fileId
				fileIDStr := chi.URLParam(r, "fileId")
				if fileIDStr != "" {
					fileID, err := uuid.Parse(fileIDStr)
					if err != nil {
						http.Error(w, "Invalid file ID format", http.StatusBadRequest)
						return
					}
					// Query the database to find the project_id for this file_id
					query := `SELECT project_id FROM files WHERE id = $1`
					err = database.DB.QueryRow(context.Background(), query, fileID).Scan(&projectID)
					if err != nil {
						if err == pgx.ErrNoRows {
							http.Error(w, "File not found", http.StatusNotFound)
							return
						}
						http.Error(w, "Failed to determine project from file", http.StatusInternalServerError)
						return
					}
				} else {
					http.Error(w, "Could not determine project context from URL", http.StatusBadRequest)
					return
				}
			}

			// Now check the user's role in the determined project
			var userRole string
			roleQuery := `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`
			err = database.DB.QueryRow(context.Background(), roleQuery, projectID, userID).Scan(&userRole)

			if err != nil {
				if err == pgx.ErrNoRows {
					// User is not a member of this project
					http.Error(w, "Forbidden: You are not a member of this project", http.StatusForbidden)
					return
				}
				http.Error(w, "Failed to verify project membership", http.StatusInternalServerError)
				return
			}

			// Check if the user's role is in the list of required roles
			isAllowed := false
			for _, role := range requiredRoles {
				if userRole == role {
					isAllowed = true
					break
				}
			}

			if !isAllowed {
				http.Error(w, "Forbidden: You do not have the required permissions for this action", http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}