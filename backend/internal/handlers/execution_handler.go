package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"time"
)

func ExecuteCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Language string `json:"language"`
		Code     string `json:"code"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// For now, we only support javascript (via node)
	imageName := "node:18-alpine"

	// Use a context with a timeout for the entire operation.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// The command to run inside the container. We use `node -p` which evaluates and prints.
	// This is slightly different from `node -e` but works well for capturing output.
	// For more complex scripts, we would mount a file, but this is fine for simple code.
	dockerCmd := "docker"
	dockerArgs := []string{
		"run",
		"--rm", // Automatically remove the container when it exits
		"--net=none", // Disable networking for security
		"--memory=128m", // Limit memory
		"--cpus=0.5", // Limit CPU
		imageName,
		"node", "-p", req.Code, // Use -p to print the result of the expression
	}

	// Create the command
	cmd := exec.CommandContext(ctx, dockerCmd, dockerArgs...) 

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Run the command
	err := cmd.Run()

	if err != nil {
		// This can happen if the command times out or returns a non-zero exit code.
		log.Printf("Error executing docker command: %v", err)
		// We'll return the stderr to the user so they can see compilation/runtime errors.
		errorOutput := fmt.Sprintf("Execution failed:\n%s", stderr.String())
		http.Error(w, errorOutput, http.StatusBadRequest)
		return
	}

	// Send the stdout back to the client.
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"output": stdout.String()})
}