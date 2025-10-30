import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Split from 'react-split';
import { Settings } from 'lucide-react';
import { ProjectSettingsModal } from '../components/ProjectSettingsModal';
import useWebSocket from '../hooks/useWebSocket';
import PresenceBar from '../components/PresenceBar';
import Whiteboard from '../components/Whiteboard';
import FileExplorer from '../components/FileExplorer';
import { type FileNodeData } from '../components/FileTreeNode';
import { type UserPresence } from '../types';
import Editor, { type OnChange, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import apiClient from '../api/axios';
import '../styles/split.css';
import { WebRTCCall } from '../components/WebRTCCall';
import { useAuth } from '../contexts/AuthContext';
export type CallState = 'idle' | 'connecting' | 'connected' | 'failed';

const ProjectWorkspacePage: React.FC = () => {
    const navigate = useNavigate();
    const { projectId } = useParams<{ projectId: string }>();
    const { user } = useAuth();
    const userId = user?.id || '';
    const [activeView, setActiveView] = useState<'code' | 'whiteboard'>('code');
    const { messages, isConnected, sendMessage } = useWebSocket(projectId);

    const [onlineUsers, setOnlineUsers] = useState<UserPresence[]>([]);
    const [output, setOutput] = useState<string>("");
    const [isExecuting, setIsExecuting] = useState(false);

    const [activeFile, setActiveFile] = useState<FileNodeData | null>(null);
    const [editorContent, setEditorContent] = useState<string | null>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const isApplyingRemoteChange = useRef(false);
    const [refetchTrigger, setRefetchTrigger] = useState(0);

    const [isInCall, setIsInCall] = useState(false);
    const [callId, setCallId] = useState(0);

    const [userRole, setUserRole] = useState<'owner' | 'editor' | 'viewer' | null>(null);

    const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
    // Fetch the role when the component mounts
    useEffect(() => {
        if (projectId) {
            apiClient.get(`/project/${projectId}/role`)
                .then(response => {

                    setUserRole(response.data.role);
                })
                .catch(error => {
                    console.error("Failed to fetch user role", error);
                    // Maybe show an error message or redirect
                });
        }
    }, [projectId]);

    const isEditorOrOwner = userRole === 'owner' || userRole === 'editor';
    useEffect(() => {
        const latestMessage = messages.at(-1);
        if (!latestMessage) return;

        switch (latestMessage.type) {
            case 'presence_update':
                setOnlineUsers(latestMessage.payload.users);
                break;
            case "file_created": case "file_renamed":
                setRefetchTrigger(c => c + 1);
                break;
            case "file_deleted":
                const deletedFileId = latestMessage.payload.id;
                setRefetchTrigger(c => c + 1);
                if (activeFile?.id === deletedFileId) {
                    setActiveFile(null);
                }
                break;
            case "editor_update":
                const { fileId, content } = latestMessage.payload;
                if (activeFile?.id === fileId) {
                    setEditorContent(content);
                    if (editorRef.current && editorRef.current.getValue() !== content) {
                        isApplyingRemoteChange.current = true;
                        const pos = editorRef.current.getPosition();
                        editorRef.current.setValue(content);
                        if (pos) editorRef.current.setPosition(pos);
                    }
                }
                break;
            case "permission_updated":
                const newRole = latestMessage.payload.newRole;
                alert(`Your role has been changed to: ${newRole}.`);
                setUserRole(newRole);
                break;

            case "force_disconnect":
                alert(latestMessage.payload.reason);
                navigate('/dashboard');
                break;
        }
    }, [messages, activeFile]);

    const handleProjectDeleted = () => {
        alert("This project has been deleted. You will be redirected to your dashboard.");
        setIsSettingsModalOpen(false);
        navigate('/dashboard');
    }

    const handleJoinLeaveCall = () => {
        setIsInCall(prev => {
            if (!prev) setCallId(id => id + 1);
            return !prev;
        });
    };

    const handleInviteClick = async () => {
        if (!projectId) return;

        try {
            const response = await apiClient.post(`/project/${projectId}/invites`);
            const { inviteCode } = response.data;
            // Create a full URL for sharing
            const inviteLink = `${window.location.origin}/invite/${inviteCode}`;

            // Copy to clipboard and alert the user
            await navigator.clipboard.writeText(inviteLink);
            alert(`Invite link copied to clipboard!\n${inviteLink}`);
        } catch (error) {
            console.error("Failed to create invite:", error);
            alert("Failed to create invite link. You might not have permission.");
        }
    };

    const handleFileSelect = (file: FileNodeData | null) => {
        if (!file) { setActiveFile(null); return; }
        if (activeFile?.id === file.id) return;
        setActiveFile(file);
        setEditorContent(null);
        sendMessage({ type: "request_file_content", payload: { fileId: file.id } });
    };

    const handleEditorChange: OnChange = (value) => {
        if (isApplyingRemoteChange.current) {
            isApplyingRemoteChange.current = false;
            return;
        }
        if (activeFile && value !== undefined) {
            setEditorContent(value);
            sendMessage({ type: "editor_update", payload: { fileId: activeFile.id, content: value } });
        }
    };

    const handleRunCode = async () => {
        if (!activeFile || activeFile.isFolder || !editorRef.current) return;
        setIsExecuting(true);
        setOutput("");
        const code = editorRef.current.getValue();
        try {
            const response = await apiClient.post(`/project/${projectId}/execute`, { language: 'javascript', code });
            setOutput(response.data.output);
        } catch (error: any) {
            setOutput(error.response?.data?.message || "An error occurred during execution.");
        } finally {
            setIsExecuting(false);
        }
    };

    const handleEditorMount: OnMount = (editor) => {
        editorRef.current = editor;
        editor.focus();
    };

    const handleSaveCode = async () => {
        if (!activeFile || editorContent === null) return;
        try {
            await apiClient.put(`/file/${activeFile.id}/content`, { content: editorContent });
            console.log("File saved!");
        } catch {
            alert("Could not save file.");
        }
    };

    return (
        <div className="flex flex-col h-full bg-gradient-to-br from-gray-900 to-black text-white">
            {/* Top bar */}
            <div className="p-3 flex-shrink-0 bg-gradient-to-r from-gray-800 to-gray-900 border-b border-gray-700 shadow-md">
                <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-4">
                        <h1 className="text-2xl font-extrabold tracking-tight">Project Workspace</h1>
                        <div className="flex items-center gap-1 rounded-lg bg-gray-700/60 p-1">
                            {['code', 'whiteboard'].map(view => (
                                <button
                                    key={view}
                                    onClick={() => setActiveView(view as any)}
                                    className={`px-4 py-1 text-sm font-medium rounded-md transition-all ${activeView === view
                                        ? 'bg-blue-600 shadow-lg'
                                        : 'text-gray-300 hover:bg-gray-600/70'
                                        }`}
                                >
                                    {view.charAt(0).toUpperCase() + view.slice(1)}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        {activeView === 'code' && (
                            <>
                                <button onClick={handleSaveCode} disabled={!isEditorOrOwner} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 font-semibold transition">💾 Save</button>
                                <button
                                    onClick={handleRunCode}
                                    disabled={isExecuting || !isEditorOrOwner}
                                    className={`px-4 py-2 rounded font-semibold transition ${isExecuting ? 'bg-gray-500' : 'bg-green-600 hover:bg-green-700'
                                        }`}
                                >
                                    {isExecuting ? 'Running...' : '▶ Run'}
                                </button>
                            </>
                        )}
                        <div className="text-right text-xs text-gray-400 leading-tight">
                            <p>Project ID: {projectId}</p>
                            <p>Connection: <span className={isConnected ? 'text-green-500' : 'text-red-500'}>{isConnected ? 'Connected' : 'Disconnected'}</span></p>
                        </div>

                        {userRole === 'owner' && (
                            <button
                                onClick={() => setIsSettingsModalOpen(true)}
                                className="p-2 rounded-full bg-gray-600 hover:bg-gray-700 transition"
                                title="Project Settings"
                            >
                                <Settings size={20} />
                            </button>
                        )}
                    </div>
                </div>

                {isInCall && user && (
                    <WebRTCCall
                        userId={userId}
                        key={callId}
                        messages={messages}
                        sendMessage={sendMessage}
                        onCallEnd={() => setIsInCall(false)}
                    />
                )}

                <PresenceBar 
                    canInvite={userRole === 'owner'}
                    onInviteClick={handleInviteClick} users={onlineUsers} isInCall={isInCall} onJoinLeaveCall={handleJoinLeaveCall} />
            </div>

            {/* Workspace with draggable file explorer */}
            <Split className="flex-grow flex border-t border-gray-700 overflow-hidden"
                sizes={[20, 80]} minSize={200} gutterSize={6} direction="horizontal">
                <div className="bg-gray-850 border-r border-gray-700 overflow-y-auto">
                    {projectId && (
                        <FileExplorer
                            projectId={projectId}
                            onFileSelect={handleFileSelect}
                            sendMessage={sendMessage}
                            refetchTrigger={refetchTrigger}
                            activeFileId={activeFile?.id || null}
                            isReadOnly={!isEditorOrOwner}
                        />
                    )}
                </div>
                <div className="flex flex-col">
                    {activeView === 'code' && (
                        <Split className="flex h-full" sizes={[70, 30]} minSize={200} gutterSize={8} direction="horizontal">
                            <div className="h-full relative bg-gray-900 rounded-tl-lg">
                                {!activeFile && (
                                    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                                        Select a file to begin editing.
                                    </div>
                                )}
                                {activeFile && editorContent === null && (
                                    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                                        Loading {activeFile.name}...
                                    </div>
                                )}
                                {activeFile && editorContent !== null && (
                                    <Editor
                                        options={{
                                            readOnly: !isEditorOrOwner
                                        }}
                                        key={activeFile.id}
                                        height="100%"
                                        language="javascript"
                                        theme="vs-dark"
                                        onMount={handleEditorMount}
                                        onChange={handleEditorChange}
                                        value={editorContent}
                                    />
                                )}
                            </div>
                            <div className="h-full flex flex-col bg-gray-950 p-3 overflow-y-auto rounded-tr-lg">
                                <h3 className="text-sm font-bold mb-2">Output</h3>
                                <pre className="text-sm text-gray-300 whitespace-pre-wrap">{output || "Click 'Run' to see output."}</pre>
                            </div>
                        </Split>
                    )}
                    {activeView === 'whiteboard' && (
                        <Whiteboard isReadOnly={!isEditorOrOwner} projectId={projectId} sendMessage={sendMessage} messages={messages} />
                    )}

                    {/* We create a minimal `project` object for the modal to use */}
                    <ProjectSettingsModal
                        isOpen={isSettingsModalOpen}
                        onRequestClose={() => setIsSettingsModalOpen(false)}
                        project={projectId ? { id: projectId, name: 'Current Project' } : null}
                        currentUser={user}
                        onProjectDeleted={handleProjectDeleted}
                    />
                </div>
            </Split>
        </div>
    );
};

export default ProjectWorkspacePage;
