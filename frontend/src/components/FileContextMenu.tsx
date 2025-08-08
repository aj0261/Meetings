import React from 'react';
import { Menu, Item, Separator, Submenu } from 'react-contexify';
import 'react-contexify/dist/ReactContexify.css';
import { type FileNodeData } from './FileTreeNode';

export const FILE_EXPLORER_MENU_ID = "file-explorer-menu";

interface FileContextMenuProps {
    onRename: () => void;
    onDelete: () => void;
    onCreateFile: () => void;
    onCreateFolder: () => void;
    clickedNode: FileNodeData | null;
}

const FileContextMenu: React.FC<FileContextMenuProps> = ({ onRename, onDelete, onCreateFile, onCreateFolder, clickedNode }) => {
    const isFolder = clickedNode?.isFolder;
    const isBackgroundClick = clickedNode === null;

    return (
        <Menu id={FILE_EXPLORER_MENU_ID}>
            {/* Logic: Show the "New" submenu only for folders or background clicks */}
            {(isFolder || isBackgroundClick) && (
                <Submenu label="New">
                    {/* These onClick handlers will now work correctly */}
                    <Item onClick={onCreateFile}>File</Item>
                    <Item onClick={onCreateFolder}>Folder</Item>
                </Submenu>
            )}

            {/* Logic: Show actions only when a node (file or folder) is clicked */}
            {clickedNode && <Separator />}
            {clickedNode && <Item onClick={onRename}>Rename</Item>}
            {clickedNode && <Item onClick={onDelete} className="text-red-500 hover:text-white hover:bg-red-600">Delete</Item>}
        </Menu>
    );
};

export default FileContextMenu;