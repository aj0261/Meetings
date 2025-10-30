import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../api/axios';
import { Link } from 'react-router-dom';
import { UserPlus, Settings } from 'lucide-react';
import { ProjectSettingsModal } from '../components/ProjectSettingsModal'; // Import the new modal

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
    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    const [selectedProject, setSelectedProject] = useState<Project | null>(null);

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

    const handleCreateInvite = async (projectId: string, event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();

        try {
            const response = await apiClient.post(`/project/${projectId}/invites`);
            const { inviteCode } = response.data;
            const link = `${window.location.origin}/invite/${inviteCode}`;
            await navigator.clipboard.writeText(link);
            alert(`Invite link copied to clipboard!\n${link}`);
        } catch (error) {
            console.error("Failed to create invite:", error);
            alert("Failed to create invite. Only project owners can generate invites.");
        }
    };

    useEffect(() => {
        fetchProjects();
    }, []);

    const handleCreateProject = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProjectName.trim()) return;

        try {
            await apiClient.post('/projects', { name: newProjectName });
            setNewProjectName('');
            fetchProjects();
        } catch (err) {
            setError('Failed to create project.');
            console.error(err);
        }
    };

    const openSettingsModal = (project: Project, event: React.MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedProject(project);
        setIsSettingsModalOpen(true);
    };

    const handleProjectDeleted = (projectId: string) => {
        setProjects(prev => prev.filter(p => p.id !== projectId));
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-900 to-black text-white px-6 py-8">
            {/* Header */}
            <div className="flex justify-between items-center mb-8">
                <h1 className="text-3xl font-extrabold tracking-tight">
                    Welcome, {user?.username}
                </h1>
                <button
                    onClick={logout}
                    className="bg-red-600 hover:bg-red-700 px-5 py-2 rounded-lg shadow-md transition-all hover:shadow-red-500/30"
                >
                    Logout
                </button>
            </div>

            {/* Accent line */}
            <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 rounded-full mb-8" />

            {/* Create Project Form */}
            <h2 className="text-xl font-semibold mb-4">Create a New Project</h2>
            <form onSubmit={handleCreateProject} className="flex gap-3 mb-10">
                <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="Enter project name"
                    className="flex-grow px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
                />
                <button
                    type="submit"
                    className="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-semibold shadow-md hover:shadow-blue-500/30 transition-transform transform hover:scale-105"
                >
                    Create
                </button>
            </form>

            {/* Project List */}
            <h2 className="text-xl font-semibold mb-4">Your Projects</h2>
            {isLoading && <p className="text-gray-400">Loading projects...</p>}
            {error && <p className="text-red-400">{error}</p>}
            {!isLoading && (!projects || projects.length === 0) && (
                <p className="text-gray-400">You don't have any projects yet. Create one above!</p>
            )}

            <ul className="space-y-4">
                {projects.map((project) => (
                    <li
                        key={project.id}
                        className="bg-gray-800/80 border border-gray-700 rounded-lg shadow-lg hover:shadow-xl hover:border-blue-500/70 transition-all duration-200 p-4 flex items-center justify-between group"
                    >
                        <Link to={`/projects/${project.id}`} className="flex flex-col">
                            <h3 className="text-lg font-medium group-hover:text-blue-400 transition-colors">
                                {project.name}
                            </h3>
                            <small className="text-gray-400">
                                Created: {new Date(project.createdAt).toLocaleString()}
                            </small>
                        </Link>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={(e) => handleCreateInvite(project.id, e)}
                                className="ml-4 bg-teal-600 hover:bg-teal-700 p-2 rounded-full shadow hover:shadow-teal-500/30 transition-transform transform hover:scale-110"
                                title="Invite"
                            >
                                <UserPlus className="w-5 h-5 text-white" />
                            </button>
                            <button
                                onClick={(e) => openSettingsModal(project, e)}
                                className="ml-4 bg-gray-600 hover:bg-gray-700 p-2 rounded-full shadow hover:shadow-gray-500/30 transition-transform transform hover:scale-110"
                                title="Settings"
                            >
                                <Settings className="w-5 h-5 text-white" />
                            </button>
                        </div>
                    </li>
                ))}
            </ul>


            {/* Add the modal to the component's return */}
            <ProjectSettingsModal
                isOpen={isSettingsModalOpen}
                onRequestClose={() => setIsSettingsModalOpen(false)}
                project={selectedProject}
                currentUser={user}
                onProjectDeleted={handleProjectDeleted}
            />
        </div>
    );
};

export default DashboardPage;
