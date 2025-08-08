import React from 'react';
import { VscFolder, VscFolderOpened, VscFileCode } from 'react-icons/vsc';
import clsx from 'clsx';

export interface FileNodeData {
    id: string;
    name: string;
    isFolder: boolean;
    children?: FileNodeData[];
    parentId?: string | null;
}

// The props are changed to control the state from the parent
interface FileTreeNodeProps {
    node: FileNodeData;
    onNodeClick: (node: FileNodeData) => void;
    activeFileId: string | null;
    onContextMenu: (event: React.MouseEvent, node: FileNodeData) => void;
    children?: React.ReactNode;
    isOpen: boolean;      // Receives open/closed state from parent
    onToggle: () => void; // A function to tell the parent it was clicked
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({ node, onNodeClick, activeFileId, onContextMenu, children, isOpen, onToggle }) => {
    // We have removed `useState` and the `shouldBeOpen` variable.
    // The component now relies entirely on the `isOpen` prop from its parent.

    if (node.isFolder) {
        return (
            <div>
                <div
                    // The onClick now calls the onToggle function passed from the parent
                    onClick={onToggle}
                    onContextMenu={(e) => onContextMenu(e, node)}
                    className="flex items-center gap-1 cursor-pointer p-1 rounded hover:bg-gray-700"
                >
                    {/* The icon is determined directly by the `isOpen` prop */}
                    {isOpen ? <VscFolderOpened /> : <VscFolder />}
                    <span>{node.name}</span>
                </div>
                {/* The children are rendered directly based on the `isOpen` prop */}
                {isOpen && <div className="pl-4 border-l border-gray-600 ml-2">{children}</div>}
            </div>
        );
    }

    return (
        <div
            onContextMenu={(e) => onContextMenu(e, node)}
            onClick={() => onNodeClick(node)}
            className={clsx("flex items-center gap-1 cursor-pointer p-1 rounded hover:bg-gray-700 text-sm", { "bg-blue-800 text-white": node.id === activeFileId })}
        >
            <VscFileCode className="text-blue-400"/>
            <span>{node.name}</span>
        </div>
    );
};

export default FileTreeNode;