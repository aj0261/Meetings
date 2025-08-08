package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"project-meetings/backend/internal/auth"
	"project-meetings/backend/internal/database"
	"project-meetings/backend/internal/models"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// Handler for user registration
func RegisterUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Basic validation
	if req.Password == "" || req.Email == "" || req.Username == "" {
		http.Error(w, "Username, email, and password are required", http.StatusBadRequest)
		return
	}

	// Hash the password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		http.Error(w, "Failed to hash password", http.StatusInternalServerError)
		return
	}

	// Insert user into the database
	query := `INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, created_at, updated_at`
	var userID uuid.UUID
	var createdAt, updatedAt time.Time

	err = database.DB.QueryRow(context.Background(), query, req.Username, req.Email, string(hashedPassword)).Scan(&userID, &createdAt, &updatedAt)
	if err != nil {
		log.Printf("Failed to insert user: %v", err)
		http.Error(w, "Email or username already exists", http.StatusConflict) // 409 Conflict
		return
	}

	// Return the newly created user (without password hash)
	newUser := models.User{
		ID:        userID,
		Username:  req.Username,
		Email:     req.Email,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(newUser)
}

// Handler for user login
func LoginUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Find user by email
	var user models.User
	query := `SELECT id, email, username, password_hash FROM users WHERE email = $1`
	err := database.DB.QueryRow(context.Background(), query, req.Email).Scan(&user.ID, &user.Email, &user.Username, &user.PasswordHash)
	if err != nil {
		// User not found, but give a generic error for security
		http.Error(w, "Invalid email or password", http.StatusUnauthorized)
		return
	}

	// Compare the provided password with the stored hash
	err = bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password))
	if err != nil {
		// Password does not match
		http.Error(w, "Invalid email or password", http.StatusUnauthorized)
		return
	}

	// Generate JWT
	token, err := auth.CreateJWT(user.ID.String(), user.Username)
	if err != nil {
		http.Error(w, "Failed to create token", http.StatusInternalServerError)
		return
	}

	// Return the token and user info
	response := map[string]interface{}{
		"token": token,
		"user": map[string]string{
			"id":       user.ID.String(),
			"username": user.Username,
			"email":    user.Email,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}