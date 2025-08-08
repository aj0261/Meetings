package middleware

import (
	"context"
	"net/http"
	"strings"

	"project-meetings/backend/internal/auth" // Import the auth package
)

type contextKey string

const UserIDKey contextKey = "userID"
const UsernameKey contextKey = "username" // Also useful to have the username

func Auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, "Authorization header required", http.StatusUnauthorized)
			return
		}
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		// Use our new, centralized validation function!
		claims, err := auth.ValidateJWTAndGetClaims(tokenString)
		if err != nil {
			http.Error(w, "Invalid token", http.StatusUnauthorized)
			return
		}

		// Add user info to the context for other handlers to use.
		ctx := context.WithValue(r.Context(), UserIDKey, claims.UserID)
		ctx = context.WithValue(ctx, UsernameKey, claims.Username)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}