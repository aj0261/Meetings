import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../api/axios';
import { Link } from 'react-router-dom';
// Define a type for our project object
interface Project {
    id: string;
    name: string;
    createdAt: string;
}

const DashboardPage: React.FC = () => {
    const { user, logout } = useAuth();
    const [projects, setProjects] = useState<Project[]>([]);
    const [newProjectName, setNewProjectName] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Function to fetch projects
    const fetchProjects = async () => {
        try {
            setIsLoading(true);
            const response = await apiClient.get<Project[]>('/projects');
            setProjects(response.data);
            setError(null);
        } catch (err) {
            setError('Failed to fetch projects.');
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    };

    // Fetch projects when the component mounts
    useEffect(() => {
        fetchProjects();
    }, []);

    const handleCreateProject = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProjectName.trim()) return;

        try {
            await apiClient.post('/projects', { name: newProjectName });
            setNewProjectName(''); // Clear the input
            fetchProjects(); // Re-fetch the list to show the new project
        } catch (err) {
            setError('Failed to create project.');
            console.error(err);
        }
    };

    return (
        <div style={{ maxWidth: '800px', margin: '20px auto', padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h1>Welcome, {user?.username}!</h1>
                <button onClick={logout}>Logout</button>
            </div>

            <hr style={{ margin: '20px 0' }} />

            <h2>Create a New Project</h2>
            <form onSubmit={handleCreateProject} style={{ display: 'flex', gap: '10px', marginBottom: '30px' }}>
                <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="Enter project name"
                    style={{ flexGrow: 1, padding: '10px' }}
                />
                <button type="submit" style={{ padding: '10px 20px' }}>Create</button>
            </form>

            <h2>Your Projects</h2>
            {isLoading && <p>Loading projects...</p>}
            {error && <p style={{ color: 'red' }}>{error}</p>}
            {!isLoading && (!projects || projects.length === 0) && (
                <p>You don't have any projects yet. Create one above!</p>
            )}
            <ul style={{ listStyle: 'none', padding: 0 }}>
                {projects && projects.length > 0 && projects.map((project) => (
                    <Link
                        key={project.id}
                        to={`/projects/${project.id}`}
                        style={{ textDecoration: 'none' }} // To remove the default underline from the link
                    >
                        <li style={{ background: '#f9f9f9', border: '1px solid #ddd', padding: '15px', marginBottom: '10px', borderRadius: '5px', color: '#333', cursor: 'pointer' }}>
                            <h3>{project.name}</h3>
                            <small>Created: {new Date(project.createdAt).toLocaleString()}</small>
                        </li>
                    </Link>
                ))}
            </ul>
        </div>
    );
};

export default DashboardPage;