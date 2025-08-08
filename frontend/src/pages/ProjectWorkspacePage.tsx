import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import Split from 'react-split';
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
import { WebRTCCall } from '../components/WebRTCCall'; // Import the new component

export type CallState = 'idle' | 'connecting' | 'connected' | 'failed';

const ProjectWorkspacePage: React.FC = () => {
    const { projectId } = useParams<{ projectId: string }>();
    const [activeView, setActiveView] = useState<'code' | 'whiteboard'>('code');
    const { messages, isConnected, sendMessage } = useWebSocket(projectId);

    const [onlineUsers, setOnlineUsers] = useState<UserPresence[]>([]);
    const [output, setOutput] = useState<string>("");
    const [isExecuting, setIsExecuting] = useState(false);

    const [activeFile, setActiveFile] = useState<FileNodeData | null>(null);
    const [activeFileContent, setActiveFileContent] = useState<string | null>(null);
    const [editorContent, setEditorContent] = useState<string | null>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const isApplyingRemoteChange = useRef(false);
    const [refetchTrigger, setRefetchTrigger] = useState(0);

    // --- SIMPLIFIED WEBRTC STATE ---
    const [isInCall, setIsInCall] = useState(false);
    // This state is used to generate a new key, forcing a re-mount of the call component
    const [callId, setCallId] = useState(0);

    useEffect(() => {
        const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        if (!latestMessage) return;

        // Parent component now only cares about non-WebRTC messages
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
                if (activeFile && activeFile.id === deletedFileId) {
                    setActiveFile(null);
                }
                break;
            case "editor_update":
                const { fileId, content } = latestMessage.payload;
                if (activeFile?.id === fileId) {
                    setEditorContent(content);
                    if (editorRef.current && editorRef.current.getValue() !== content) {
                        isApplyingRemoteChange.current = true;
                        const editor = editorRef.current;
                        const pos = editor.getPosition();
                        editor.setValue(content);
                        if (pos) editor.setPosition(pos);
                    }
                }
                break;
        }
    }, [messages, activeFile]);

    const handleJoinLeaveCall = () => {
        setIsInCall(prev => {
            // If we are NOT currently in a call, we are about to join.
            if (!prev) {
                // Increment the callId to get a new key, forcing a fresh component mount.
                setCallId(id => id + 1);
            }
            // Toggle the call state.
            return !prev;
        });
    };

    // When a file is selected...
    const handleFileSelect = (file: FileNodeData | null) => { // Now accepts null
        // If the file is null, it means we need to close the editor.
        if (file === null) {
            setActiveFile(null);
            return;
        }

        if (activeFile?.id === file.id) return;

        setActiveFile(file);
        setActiveFileContent(null);
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

    const handleEditorMount: OnMount = (editor) => { editorRef.current = editor; editor.focus(); };

    return (
        <div className="flex flex-col h-full bg-gray-900 text-white">
            <div className="p-3 flex-shrink-0 bg-gray-800 border-b border-gray-700">
                <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-4">
                        <h1 className="text-2xl font-bold">Project Workspace</h1>
                        <div className="flex items-center gap-2 rounded-lg bg-gray-700 p-1">
                            <button onClick={() => setActiveView('code')} className={`px-3 py-1 text-sm rounded-md ${activeView === 'code' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-600'}`}>Code</button>
                            <button onClick={() => setActiveView('whiteboard')} className={`px-3 py-1 text-sm rounded-md ${activeView === 'whiteboard' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-600'}`}>Whiteboard</button>
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        {activeView === 'code' && <button onClick={handleRunCode} disabled={isExecuting} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded disabled:bg-gray-500">{isExecuting ? 'Running...' : '▶ Run'}</button>}
                        <div className="text-right text-xs text-gray-400">
                            <p>Project ID: {projectId}</p>
                            <p>Connection: <span className={isConnected ? 'text-green-500' : 'text-red-500'}>{isConnected ? 'Connected' : 'Disconnected'}</span></p>
                        </div>
                    </div>
                </div>

                {/* Conditionally render the WebRTCCall component with a unique key for each new call */}
                {isInCall && (
                    <WebRTCCall
                        key={callId} // This is the magic!
                        messages={messages}
                        sendMessage={sendMessage}
                        onCallEnd={() => setIsInCall(false)}
                    />
                )}

                <PresenceBar users={onlineUsers} isInCall={isInCall} onJoinLeaveCall={handleJoinLeaveCall} />
            </div>

            <div className="flex-grow flex border-t border-gray-700 overflow-hidden">
                <div className="w-64 flex-shrink-0 bg-gray-800 border-r border-gray-700">
                    {projectId && <FileExplorer projectId={projectId} onFileSelect={handleFileSelect} sendMessage={sendMessage} refetchTrigger={refetchTrigger} activeFileId={activeFile?.id || null} />}
                </div>
                <div className="flex-grow">
                    <div className={activeView === 'code' ? 'h-full' : 'hidden'}>
                        <Split className="flex h-full" sizes={[70, 30]} minSize={200} gutterSize={8} direction="horizontal">
                            <div className="h-full bg-gray-850 relative">
                                {!activeFile && <div className="absolute inset-0 flex items-center justify-center text-gray-500"><p>Select a file to begin editing.</p></div>}
                                {activeFile && editorContent === null && (
                                    <div className="absolute inset-0 flex items-center justify-center text-gray-500">
                                        <p >Loading {activeFile.name}...</p>
                                    </div>
                                )}
                                {activeFile && editorContent !== null && (
                                    <Editor
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
                            <div className="h-full flex flex-col bg-gray-900 p-2 overflow-y-auto">
                                <h3 className="text-sm font-bold mb-2 flex-shrink-0">Output</h3>
                                <pre className="text-sm text-gray-300 whitespace-pre-wrap">{output || "Click 'Run' to see the output of your code."}</pre>
                            </div>
                        </Split>
                    </div>
                    <div className={activeView === 'whiteboard' ? 'h-full' : 'hidden'}>
                        <Whiteboard projectId={projectId} sendMessage={sendMessage} messages={messages} />
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ProjectWorkspacePage;