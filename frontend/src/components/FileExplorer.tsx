import React, { useState, useEffect, useRef } from 'react';
import Modal from 'react-modal';
import apiClient from '../api/axios';
import FileTreeNode, { type FileNodeData } from './FileTreeNode';
import FileContextMenu, { FILE_EXPLORER_MENU_ID } from './FileContextMenu';
import { useContextMenu } from 'react-contexify';
import { VscNewFile, VscNewFolder, VscFolder, VscFileCode } from 'react-icons/vsc';

interface FileExplorerProps {
    projectId: string;
    onFileSelect: (file: FileNodeData | null) => void;
    sendMessage: (message: object) => void;
    refetchTrigger: number;
    activeFileId: string | null;
    isReadOnly : boolean,
}

const InlineInput = ({ type, defaultValue = "", onSubmit, onCancel }: any) => {
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
    return (
        <div className="flex items-center gap-1 p-1">
            {type.includes('folder') ? <VscFolder /> : <VscFileCode className="text-blue-400" />}
            <input ref={inputRef} type="text" defaultValue={defaultValue} className="bg-gray-900 text-white text-sm w-full outline-none px-1" onBlur={(e) => onSubmit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(e.currentTarget.value); if (e.key === 'Escape') onCancel(); }} />
        </div>
    );
};

const FileExplorer: React.FC<FileExplorerProps> = ({ projectId, onFileSelect, sendMessage, refetchTrigger, activeFileId }) => {
    const [fileTree, setFileTree] = useState<FileNodeData[]>([]);
    const [contextNode, setContextNode] = useState<FileNodeData | null>(null);
    const [inlineAction, setInlineAction] = useState<{ type: 'create-file' | 'create-folder' | 'rename', parentId: string | null, nodeToRename?: FileNodeData } | null>(null);
    const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
    const { show } = useContextMenu({ id: FILE_EXPLORER_MENU_ID });
    const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

    const fetchFileTree = () => { apiClient.get(`/project/${projectId}/files`).then(res => setFileTree(res.data || [])).catch(err => console.error("Failed to fetch files:", err)); };
    useEffect(() => { fetchFileTree(); }, [projectId, refetchTrigger]);
    const ensureFolderIsOpen = (folderId: string) => {
        // A folder is considered closed only if it's explicitly set to 'false'.
        if (openFolders[folderId] === false) {
            // We don't toggle here; we explicitly set it to 'true'.
            setOpenFolders(prev => ({ ...prev, [folderId]: true }));
        }
    };
    const handleContextMenu = (event: React.MouseEvent, node: FileNodeData | null) => { event.preventDefault(); event.stopPropagation(); setContextNode(node); show({ event }); };
    const handleCreateFile = () => {
        const parentId = contextNode?.isFolder ? contextNode.id : null;
        // If we are creating the file inside a folder...
        if (parentId) {
            // ...ensure that folder is open before showing the input.
            ensureFolderIsOpen(parentId);
        }
        setInlineAction({ type: 'create-file', parentId });
    };

    const handleCreateFolder = () => {
        const parentId = contextNode?.isFolder ? contextNode.id : null;
        // If we are creating the folder inside another folder...
        if (parentId) {
            // ...ensure that folder is open before showing the input.
            ensureFolderIsOpen(parentId);
        }
        setInlineAction({ type: 'create-folder', parentId });
    };
    const handleRename = () => { if (contextNode) setInlineAction({ type: 'rename', parentId: null, nodeToRename: contextNode }); };
    const handleDeleteRequest = () => { if (contextNode) setIsDeleteModalOpen(true); };
    const handleToggleFolder = (folderId: string) => {
        setOpenFolders(prev => {
            // If the folderId is not in our map, it defaults to 'open' (true).
            // So, the first click will set it to 'false'.
            const isCurrentlyOpen = prev[folderId] !== false;
            return {
                ...prev,
                [folderId]: !isCurrentlyOpen
            };
        });
    };
    const confirmDelete = async () => {
        if (!contextNode) return;
        try {
            await apiClient.delete(`/file/${contextNode.id}`);
            sendMessage({ type: "file_deleted", payload: { id: contextNode.id } });
            if (activeFileId === contextNode.id) onFileSelect(null);
            fetchFileTree();
        } catch (error) { alert("Failed to delete."); }
        closeDeleteModal();
    };
    const closeDeleteModal = () => { setIsDeleteModalOpen(false);  
    };

    const submitInlineAction = async (name: string) => {
        if (!inlineAction || !name) { setInlineAction(null); return; }
        const { type, parentId, nodeToRename } = inlineAction;
        try {
            if (type === 'rename' && nodeToRename) {
                await apiClient.put(`/file/${nodeToRename.id}/rename`, { newName: name });
                sendMessage({ type: "file_renamed" });
            } else {
                await apiClient.post(`/project/${projectId}/files`, { parentId, isFolder: type === 'create-folder', name });
                sendMessage({ type: "file_created" });
            }
            fetchFileTree();
        } catch (error) { alert("Action failed. Name may already exist."); }
        finally { setInlineAction(null); }
    };
    const renderNodes = (nodes: FileNodeData[], parentId: string | null): React.ReactNode => (
        <>
            {nodes.map(node => (
                inlineAction?.type === 'rename' && inlineAction.nodeToRename?.id === node.id
                    ? <InlineInput key="rename-input" type={node.isFolder ? 'folder' : 'file'} defaultValue={node.name} onSubmit={submitInlineAction} onCancel={() => setInlineAction(null)} />
                    : (
                        <FileTreeNode
                            key={node.id}
                            node={node}
                            onNodeClick={onFileSelect}
                            activeFileId={activeFileId}
                            onContextMenu={handleContextMenu}
                            // --- PROPS UPDATED/ADDED ---
                            // If a folder's ID is not in our map, it defaults to open.
                            // Otherwise, we use its stored value.
                            isOpen={openFolders[node.id] !== false}
                            onToggle={() => handleToggleFolder(node.id)}
                        >
                            {/* This logic remains the same. It was already correct. */}
                            {node.isFolder && renderNodes(node.children || [], node.id)}
                        </FileTreeNode>
                    )
            ))}
            {inlineAction && (inlineAction.type === 'create-file' || inlineAction.type === 'create-folder') && inlineAction.parentId === parentId && (
                <InlineInput type={inlineAction.type} onSubmit={submitInlineAction} onCancel={() => setInlineAction(null)} />
            )}
        </>
    );

    return (
        <div className="h-full bg-gray-800 text-gray-300 p-2 flex flex-col">
            <div className="flex justify-between items-center mb-2 flex-shrink-0">
                <h2 className="text-xs font-bold uppercase">Explorer</h2>
                <div className="flex gap-2">
                    <button onClick={() => setInlineAction({ type: 'create-file', parentId: null })} title="New File"><VscNewFile /></button>
                    <button onClick={() => setInlineAction({ type: 'create-folder', parentId: null })} title="New Folder"><VscNewFolder /></button>
                </div>
            </div>
            {/* This div is now the one that grows and scrolls */}
            <div
                className="flex-grow overflow-y-auto"
                onContextMenu={(e) => {
                    e.preventDefault();
                    handleContextMenu(e, null);
                }}
            >
                {renderNodes(fileTree, null)}
            </div>
            <FileContextMenu
                clickedNode={contextNode}
                onRename={handleRename}
                onDelete={handleDeleteRequest}
                onCreateFile={handleCreateFile}
                onCreateFolder={handleCreateFolder}
            />
            <Modal
                isOpen={isDeleteModalOpen}
                onRequestClose={closeDeleteModal}
                contentLabel="Confirm Deletion"
                className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 
             bg-gray-900 text-white rounded-lg p-6 shadow-lg w-full max-w-md z-50"
                overlayClassName="fixed inset-0 bg-transparent" // invisible overlay so outside clicks still close
            >
                <h2 className="text-xl font-bold mb-4">Confirm Deletion</h2>
                <p className="text-gray-300 mb-6">
                    Are you sure you want to delete{" "}
                    <strong className="text-yellow-400">{contextNode?.name}</strong>? This action cannot be undone.
                </p>
                <div className="flex justify-end gap-4">
                    <button
                        onClick={closeDeleteModal}
                        className="px-4 py-2 rounded bg-gray-600 hover:bg-gray-500 text-white"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={confirmDelete}
                        className="px-4 py-2 rounded bg-red-600 hover:bg-red-500 text-white"
                    >
                        Delete
                    </button>
                </div>
            </Modal>


        </div>
    );
};
export default FileExplorer;