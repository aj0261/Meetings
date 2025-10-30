package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"project-meetings/backend/internal/database"
	"project-meetings/backend/internal/models"
	"log"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// GetFileTree handles fetching all files and folders for a project and structuring them as a tree.
func GetFileTree(w http.ResponseWriter, r *http.Request) {
	projectIDStr := chi.URLParam(r, "projectId")
	projectID, err := uuid.Parse(projectIDStr)
	if err != nil {
		http.Error(w, "Invalid project ID", http.StatusBadRequest)
		return
	}

	// Fetch all nodes for the project from the database
	query := `SELECT id, parent_id, is_folder, name, content, created_at, updated_at FROM files WHERE project_id = $1 ORDER BY name ASC`
	rows, err := database.DB.Query(context.Background(), query, projectID)
	if err != nil {
		http.Error(w, "Failed to retrieve file structure", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	nodes := make(map[uuid.UUID]*models.FileNode)
	var allNodes []*models.FileNode
	for rows.Next() {
		var node models.FileNode
		node.ProjectID = projectID
		if err := rows.Scan(&node.ID, &node.ParentID, &node.IsFolder, &node.Name, &node.Content, &node.CreatedAt, &node.UpdatedAt); err != nil {
			http.Error(w, "Failed to scan file node", http.StatusInternalServerError)
			return
		}
		nodes[node.ID] = &node
		allNodes = append(allNodes, &node)
	}

	// Build the tree structure
	var tree []*models.FileNode
	for _, node := range allNodes {
		if node.ParentID == nil {
			// This is a root node
			tree = append(tree, node)
		} else {
			// This is a child node, find its parent
			if parent, ok := nodes[*node.ParentID]; ok {
				parent.Children = append(parent.Children, node)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}

// CreateFileNode handles creating a new file or folder.
func CreateFileNode(w http.ResponseWriter, r *http.Request) {
	projectIDStr := chi.URLParam(r, "projectId")
	projectID, err := uuid.Parse(projectIDStr)
	if err != nil {
		http.Error(w, "Invalid project ID", http.StatusBadRequest)
		return
	}

	var req struct {
		ParentID *string `json:"parentId"` // Can be null for root
		IsFolder bool    `json:"isFolder"`
		Name     string  `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	var parentID *uuid.UUID
	if req.ParentID != nil {
		parsed, err := uuid.Parse(*req.ParentID)
		if err != nil {
			http.Error(w, "Invalid parent ID", http.StatusBadRequest)
			return
		}
		parentID = &parsed
	}
    
    // For new files, provide empty content.
    content := ""
    var contentPtr *string
    if !req.IsFolder {
        contentPtr = &content
    }

	query := `INSERT INTO files (project_id, parent_id, is_folder, name, content) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at, updated_at`
	var newNode models.FileNode
	err = database.DB.QueryRow(context.Background(), query, projectID, parentID, req.IsFolder, req.Name, contentPtr).Scan(&newNode.ID, &newNode.CreatedAt, &newNode.UpdatedAt)
	if err != nil {
		http.Error(w, "Failed to create file/folder. Check for duplicate names.", http.StatusInternalServerError)
		return
	}
    
    // Populate the rest of the response struct
    newNode.ProjectID = projectID
    newNode.ParentID = parentID
    newNode.IsFolder = req.IsFolder
    newNode.Name = req.Name
    newNode.Content = contentPtr

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(newNode)
}

// TODO: We will also need handlers for Update (rename, move, save content) and Delete.
// Let's build Get and Create first.
// In file_handlers.go
func SaveFileContent(w http.ResponseWriter, r *http.Request) {
    fileIDStr := chi.URLParam(r, "fileId")
    fileID, err := uuid.Parse(fileIDStr)
    if err != nil {
        http.Error(w, "Invalid file ID", http.StatusBadRequest)
        return
    }

    var req struct {
        Content string `json:"content"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request body", http.StatusBadRequest)
        return
    }

    query := `UPDATE files SET content = $1, updated_at = NOW() WHERE id = $2`
    _, err = database.DB.Exec(context.Background(), query, req.Content, fileID)
    if err != nil {
        log.Printf("Failed to save file content: %v", err)
        http.Error(w, "Failed to save file", http.StatusInternalServerError)
        return
    }

    w.WriteHeader(http.StatusOK)
}
// RenameFileNode handles renaming a file or folder.
func RenameFileNode(w http.ResponseWriter, r *http.Request) {
	fileIDStr := chi.URLParam(r, "fileId")
	fileID, err := uuid.Parse(fileIDStr)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	var req struct {
		NewName string `json:"newName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	if req.NewName == "" {
		http.Error(w, "New name is required", http.StatusBadRequest)
		return
	}

	query := `UPDATE files SET name = $1, updated_at = NOW() WHERE id = $2`
	_, err = database.DB.Exec(context.Background(), query, req.NewName, fileID)
	if err != nil {
		// This can fail due to the UNIQUE constraint if the name already exists
		log.Printf("Failed to rename file: %v", err)
		http.Error(w, "Failed to rename. A file or folder with that name may already exist.", http.StatusConflict)
		return
	}

	w.WriteHeader(http.StatusOK)
}

// DeleteFileNode handles deleting a file or folder (and its children recursively).
func DeleteFileNode(w http.ResponseWriter, r *http.Request) {
	fileIDStr := chi.URLParam(r, "fileId")
	fileID, err := uuid.Parse(fileIDStr)
	if err != nil {
		http.Error(w, "Invalid file ID", http.StatusBadRequest)
		return
	}

	// Because of `ON DELETE CASCADE` in our SQL schema, PostgreSQL will handle
	// deleting all children automatically when a folder is deleted.
	query := `DELETE FROM files WHERE id = $1`
	_, err = database.DB.Exec(context.Background(), query, fileID)
	if err != nil {
		log.Printf("Failed to delete file: %v", err)
		http.Error(w, "Failed to delete file or folder", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent) // 204 No Content is standard for a successful DELETE
}
