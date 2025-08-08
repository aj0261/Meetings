package main

import (
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/joho/godotenv"
	"project-meetings/backend/internal/database"
	"project-meetings/backend/internal/handlers"
	"project-meetings/backend/internal/middleware"
	"project-meetings/backend/internal/ws"
)

type application struct {
	hub *ws.Hub
}

func main() {
	err := godotenv.Load("../../.env")
	if err != nil {
		log.Println("No .env file found, reading from environment")
	}

	database.Connect()
	defer database.DB.Close()
	hub := ws.NewHub()
	go hub.Run()

	app := &application{
		hub: hub,
	}

	r := chi.NewRouter()

	r.Use(chimiddleware.Logger)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"http://localhost:5173"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Get("/ws/{projectId}", app.ServeWs)
	// API Routes
	r.Route("/api/v1", func(r chi.Router) {
		// Public routes
		r.Post("/auth/register", handlers.RegisterUser)
		r.Post("/auth/login", handlers.LoginUser)

		// Protected routes
		r.Group(func(r chi.Router) {
			// Apply the Auth middleware to this group
			r.Use(middleware.Auth)

			r.Post("/projects", handlers.CreateProject)
			r.Get("/projects", handlers.GetUserProjects)
			r.Post("/project/{projectId}/execute", handlers.ExecuteCode)
			r.Get("/project/{projectId}/whiteboardState", app.GetWhiteboardState)
			r.Get("/project/{projectId}/files", handlers.GetFileTree)
            r.Post("/project/{projectId}/files", handlers.CreateFileNode)
			r.Put("/file/{fileId}/rename", handlers.RenameFileNode)
            r.Delete("/file/{fileId}", handlers.DeleteFileNode)
		})
	})

	log.Println("Starting server on :8080")
	if err := http.ListenAndServe(":8080", r); err != nil {
		log.Fatalf("Could not start server: %s\n", err)
	}
}

func (app *application) ServeWs(w http.ResponseWriter, r *http.Request) {
	handlers.ServeWs(app.hub, w, r)
}
func (app *application) GetWhiteboardState(w http.ResponseWriter, r *http.Request) {
    handlers.GetWhiteboardState(app.hub, w, r)
}
