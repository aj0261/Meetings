// frontend/src/components/ProjectSettingsModal.tsx
import React, { useState, useEffect } from 'react';
import Modal from 'react-modal';
import apiClient from '../api/axios';
import { type User } from '../contexts/AuthContext'; // Assuming User type is exported
import { X, Trash2, ChevronDown } from 'lucide-react';

interface Project {
    id: string;
    name: string;
}

interface Member {
    userId: string;
    username: string;
    email: string;
    role: 'owner' | 'editor' | 'viewer';
}

interface ProjectSettingsModalProps {
    isOpen: boolean;
    onRequestClose: () => void;
    project: Project | null;
    currentUser: User | null;
    onProjectDeleted: (projectId: string) => void;
}

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({
    isOpen,
    onRequestClose,
    project,
    currentUser,
    onProjectDeleted,
}) => {
    const [members, setMembers] = useState<Member[]>([]);
    const [projectName, setProjectName] = useState(project?.name || '');
    const [deleteConfirm, setDeleteConfirm] = useState('');

    useEffect(() => {
        if (project && isOpen) {
            setProjectName(project.name);
            apiClient.get(`/project/${project.id}/members`)
                .then(res => setMembers(res.data))
                .catch(err => console.error("Failed to fetch members", err));
        }
    }, [project, isOpen]);

    const handleRename = async () => {
        if (!project || !projectName.trim() || projectName === project.name) return;
        try {
            await apiClient.put(`/project/${project.id}/rename`, { name: projectName });
            // Consider updating the project list in dashboard after rename
            alert('Project renamed successfully!');
        } catch {
            alert('Failed to rename project.');
        }
    };

    const handleDelete = async () => {
        if (!project || deleteConfirm !== project.name) {
            alert('Please type the project name to confirm deletion.');
            return;
        }
        try {
            await apiClient.delete(`/project/${project.id}`);
            onProjectDeleted(project.id);
            onRequestClose();
        } catch {
            alert('Failed to delete project.');
        }
    };
    
    const handleRoleChange = async (memberId: string, newRole: 'editor' | 'viewer') => {
        if (!project) return;
        try {
            await apiClient.put(`/project/${project.id}/members/${memberId}`, { role: newRole });
            setMembers(prev => prev.map(m => m.userId === memberId ? { ...m, role: newRole } : m));
        } catch {
            alert('Failed to change role.');
        }
    };

    const handleRemoveMember = async (memberId: string) => {
        if (!project || !window.confirm("Are you sure you want to remove this member?")) return;
        try {
            await apiClient.delete(`/project/${project.id}/members/${memberId}`);
            setMembers(prev => prev.filter(m => m.userId !== memberId));
        } catch {
            alert('Failed to remove member.');
        }
    };

    if (!project) return null;

    return (
        <Modal isOpen={isOpen} onRequestClose={onRequestClose}  overlayClassName="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50"
    // THIS IS THE KEY: Tell the direct modal container to be nothing.
    // It will just be a transparent box holding our styled content.
    className="bg-transparent border-none outline-none" >
            <div className="p-6 bg-gray-800 text-white rounded-lg max-w-2xl w-full mx-auto shadow-2xl border border-gray-700">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold">Manage '{project.name}'</h2>
                    <button onClick={onRequestClose}><X /></button>
                </div>
                
                {/* Rename Section */}
                <div className="mb-6">
                    <h3 className="text-lg font-semibold mb-2">Project Name</h3>
                    <div className="flex gap-2">
                        <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)} className="flex-grow bg-gray-700 p-2 rounded" />
                        <button onClick={handleRename} className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">Save</button>
                    </div>
                </div>

                {/* Members Section */}
                <div className="mb-6">
                    <h3 className="text-lg font-semibold mb-2">Members</h3>
                    <ul className="space-y-2">
                        {members.map(member => (
                            <li key={member.userId} className="flex justify-between items-center bg-gray-700 p-2 rounded">
                                <div>
                                    <p className="font-medium">{member.username} {member.userId === currentUser?.id && '(You)'}</p>
                                    <p className="text-sm text-gray-400">{member.email}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    {member.role === 'owner' ? (
                                        <span className="px-2 py-1 text-xs font-bold bg-yellow-500 text-black rounded-full">Owner</span>
                                    ) : (
                                        <>
                                            <select value={member.role} onChange={e => handleRoleChange(member.userId, e.target.value as any)} className="bg-gray-600 rounded p-1">
                                                <option value="editor">Editor</option>
                                                <option value="viewer">Viewer</option>
                                            </select>
                                            <button onClick={() => handleRemoveMember(member.userId)} className="text-red-500 hover:text-red-400"><Trash2 size={18} /></button>
                                        </>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>

                {/* Delete Section */}
                <div>
                    <h3 className="text-lg font-semibold text-red-500 mb-2">Danger Zone</h3>
                    <div className="bg-red-900/20 border border-red-500/30 p-4 rounded">
                        <p className="mb-2">To delete this project, type its name (<strong className="font-mono">{project.name}</strong>) in the box below and click the delete button. This action is irreversible.</p>
                        <div className="flex gap-2">
                            <input type="text" value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} className="flex-grow bg-gray-700 p-2 rounded" />
                            <button onClick={handleDelete} className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded font-bold">Delete Project</button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
};