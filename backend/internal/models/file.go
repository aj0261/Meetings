package models

import (
	"time"
	"github.com/google/uuid"
)

// FileNode represents a file or a folder in the project structure.
type FileNode struct {
	ID        uuid.UUID  `json:"id"`
	ProjectID uuid.UUID  `json:"projectId"`
	ParentID  *uuid.UUID `json:"parentId"` // Use a pointer to allow for NULL
	IsFolder  bool       `json:"isFolder"`
	Name      string     `json:"name"`
	Content   *string    `json:"content,omitempty"` // Pointer for NULL, omitempty for clean JSON
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
    // This will be populated by our handler to represent children in the tree
    Children []*FileNode `json:"children,omitempty"` 
}