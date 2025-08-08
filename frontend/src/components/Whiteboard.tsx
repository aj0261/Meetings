import React, { useState, useEffect, useRef } from 'react';
// --- FIX #1: Corrected import name ---
import { Stage, Layer, Rect, Circle, Transformer, Line, Text } from 'react-konva';
import Konva from 'konva';
import { v4 as uuidv4 } from 'uuid';
import useMeasure from 'react-use-measure';
import { type WsMessage } from '../hooks/useWebSocket';
import { type WhiteboardUpdatePayload } from '../types';
import apiClient from '../api/axios';

// --- INTERFACES ---
interface Shape {
    id: string;
    type: 'rect' | 'circle' | 'line' | 'text';
    text?: string;
    fontSize?: number;
    points?: number[];
    x?: number;
    y?: number;
    rotation?: number;
    width?: number;
    height?: number;
    radius?: number;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
}

interface WhiteboardRemovePayload {
    id: string;
}

interface WhiteboardProps {
    projectId: string | undefined;
    sendMessage: (message: object) => void;
    messages: WsMessage[];
}

// --- SUB-COMPONENT for Draggable Shapes ---
const DraggableShape = ({ shape, isSelected, onSelect, onChange, tool, onDblClick, onDelete }: any) => {
    const shapeRef = useRef<any>(null);
    const trRef = useRef<any>(null);

    useEffect(() => {
        if (isSelected && trRef.current && shapeRef.current) {
            trRef.current.nodes([shapeRef.current]);
            trRef.current.getLayer()?.batchDraw();
        }
    }, [isSelected]);

    const handleTransformEnd = () => {
        const node = shapeRef.current;
        if (!node) return;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        node.scaleX(1);
        node.scaleY(1);

        let newAttrs;
        if (shape.type === 'rect' || shape.type === 'text') {
            newAttrs = { ...shape, x: node.x(), y: node.y(), rotation: node.rotation(), width: Math.max(5, node.width() * scaleX), height: Math.max(5, node.height() * scaleY), scaleX: 1, scaleY: 1 };
        } else { // Circle
            newAttrs = { ...shape, x: node.x(), y: node.y(), rotation: node.rotation(), radius: Math.max(5, (shape.radius || 0) * Math.max(scaleX, scaleY)), scaleX: 1, scaleY: 1 };
        }
        onChange(newAttrs);
    };

    const commonProps = {
        ref: shapeRef,
        ...shape,
        draggable: tool === 'select',
        onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
            if (tool === 'eraser') {
                onDelete(shape.id);
            } else {
                onSelect(e);
            }
        },
        onTap: (e: Konva.KonvaEventObject<TouchEvent>) => {
            if (tool === 'eraser') {
                onDelete(shape.id);
            } else {
                onSelect(e);
            }
        },
        onDragEnd: (e: any) => onChange({ ...shape, x: e.target.x(), y: e.target.y() }),
        onTransformEnd: handleTransformEnd,
        onDblClick: () => onDblClick(shape),
        onDblTap: () => onDblClick(shape),
    };

    let shapeComponent;
    if (shape.type === 'rect') shapeComponent = <Rect {...commonProps} />;
    else if (shape.type === 'circle') shapeComponent = <Circle {...commonProps} />;
    else if (shape.type === 'text') shapeComponent = <Text {...commonProps} />;

    return (
        <>
            {shapeComponent}
            {/* --- FIX #2: Added types for oldBox and newBox --- */}
            {isSelected && (
                <Transformer
                    ref={trRef}
                    boundBoxFunc={(oldBox, newBox) => {
                        if (newBox.width === undefined || newBox.height === undefined) {
                            return oldBox;
                        }
                        if (newBox.width < 5 || newBox.height < 5) {
                            return oldBox;
                        }
                        return newBox;
                    }}
                />
            )}
        </>
    );
};

// --- MAIN WHITEBOARD COMPONENT ---
const Whiteboard: React.FC<WhiteboardProps> = ({ projectId, sendMessage, messages }) => {
    const [shapes, setShapes] = useState<Shape[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [tool, setTool] = useState<'select' | 'pen' | 'text' | 'eraser'>('select');
    const [isLoading, setIsLoading] = useState(true);
    const [containerRef, { width, height }] = useMeasure();
    const isDrawing = useRef(false);
    const lastUpdateTime = useRef(0);
    const [editingText, setEditingText] = useState<Shape | null>(null);
    const textUpdateTimeout = useRef<number | null>(null);

    // Effect to fetch initial state
    useEffect(() => {
        if (!projectId) return;
        setIsLoading(true);
        apiClient.get(`/project/${projectId}/whiteboardState`).then(res => {
            setShapes(res.data.shapes || []);
            setIsLoading(false);
        }).catch(err => {
            console.error("Failed to fetch whiteboard state", err);
            setIsLoading(false);
        });
    }, [projectId]);

    // Effect to handle incoming messages
    useEffect(() => {
        const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        if (!latestMessage) return;

        if (latestMessage.type === 'whiteboard_update') {
            const { shape: remoteShape } = latestMessage.payload as WhiteboardUpdatePayload;
            setShapes(currentShapes => {
                const index = currentShapes.findIndex(s => s.id === remoteShape.id);
                if (index > -1) {
                    const newShapes = [...currentShapes];
                    newShapes[index] = remoteShape;
                    return newShapes;
                } else {
                    return [...currentShapes, remoteShape];
                }
            });
        } else if (latestMessage.type === 'whiteboard_object_remove') {
            const { id } = latestMessage.payload as WhiteboardRemovePayload;
            setShapes(currentShapes => currentShapes.filter(s => s.id !== id));
        }
    }, [messages]);

    const updateAndSendShape = (updatedShape: Shape) => {
        const newShapes = shapes.map(s => (s.id === updatedShape.id ? updatedShape : s));
        setShapes(newShapes);
        sendMessage({ type: 'whiteboard_update', payload: { shape: updatedShape } });
    };

    const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
        const stage = e.target.getStage();
        if (!stage) return;
        if (e.target === stage) {
            setSelectedId(null);
            if (tool === 'pen') {
                isDrawing.current = true;
                const pos = stage.getPointerPosition();
                if (!pos) return;
                const newLine = { id: uuidv4(), type: 'line' as const, points: [pos.x, pos.y], stroke: '#000', strokeWidth: 5 };
                setShapes(prev => [...prev, newLine]);
            } else if (tool === 'text') {
                const pos = stage.getPointerPosition();
                if (!pos) return;
                const newText: Shape = { id: uuidv4(), type: 'text', x: pos.x, y: pos.y, text: 'Type here', fontSize: 24, fill: '#000000', width: 200, height: 30 };
                const newShapes = [...shapes, newText];
                setShapes(newShapes);
                sendMessage({ type: 'whiteboard_update', payload: { shape: newText } });
                setTool('select');
            }
        }
    };

    const handleMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
        if (tool !== 'pen' || !isDrawing.current) return;
        const stage = e.target.getStage();
        if (!stage) return;
        const point = stage.getPointerPosition();
        if (!point) return;

        const lastLine = shapes[shapes.length - 1];
        if (lastLine?.type === 'line') {
            const newPoints = (lastLine.points || []).concat([point.x, point.y]);
            const updatedLine = { ...lastLine, points: newPoints };
            const newShapes = [...shapes.slice(0, -1), updatedLine];
            setShapes(newShapes);
            const now = Date.now();
            if (now - lastUpdateTime.current > 50) {
                lastUpdateTime.current = now;
                sendMessage({ type: 'whiteboard_update', payload: { shape: updatedLine } });
            }
        }
    };

    const handleMouseUp = () => {
        if (tool !== 'pen' || !isDrawing.current) return;
        isDrawing.current = false;
        const finalLine = shapes[shapes.length - 1];
        if (finalLine?.type === 'line') {
            sendMessage({ type: 'whiteboard_update', payload: { shape: finalLine } });
        }
    };

    const addShape = (type: 'rect' | 'circle') => {
        setTool('select');
        const newShape = type === 'rect' ?
            { id: uuidv4(), type: 'rect' as const, x: 100, y: 100, width: 100, height: 80, fill: 'rgba(255, 255, 255, 1)', stroke: 'black', strokeWidth: 2 } :
            { id: uuidv4(), type: 'circle' as const, x: 250, y: 150, radius: 50, fill: 'rgba(255, 255, 255, 1)', stroke: 'black', strokeWidth: 2 };
        const newShapes = [...shapes, newShape];
        setShapes(newShapes);
        sendMessage({ type: 'whiteboard_update', payload: { shape: newShape } });
    };

    const handleTextDblClick = (shape: Shape) => {
        if (tool !== 'select' || shape.type !== 'text') return;
        setEditingText(shape);
    };

    const handleTextEditEnd = () => {
        if (textUpdateTimeout.current) clearTimeout(textUpdateTimeout.current);
        if (editingText) {
            const { width, height, ...finalText } = editingText;
            updateAndSendShape(finalText);
        }
        setEditingText(null);
    };

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (!editingText) return;
        const newTextContent = e.target.value;
        const updatedText = { ...editingText, text: newTextContent };
        setEditingText(updatedText);

        if (textUpdateTimeout.current) clearTimeout(textUpdateTimeout.current);
        textUpdateTimeout.current = window.setTimeout(() => {
            const { width, height, ...textToSend } = updatedText;
            updateAndSendShape(textToSend);
        }, 50);
    };

    const handleDeleteShape = (idToDelete: string) => {
        setShapes(currentShapes => currentShapes.filter(s => s.id !== idToDelete));
        sendMessage({
            type: 'whiteboard_object_remove',
            payload: { id: idToDelete } as WhiteboardRemovePayload
        });
    };

    return (
        <div className="w-full h-full flex flex-col">
            <div className="p-2 bg-gray-200 border-b border-gray-300 flex-shrink-0 flex items-center gap-2">
                <button onClick={() => setTool('select')} className={`px-3 py-1 text-sm rounded ${tool === 'select' ? 'bg-blue-600 text-white' : 'bg-gray-300'}`}>Select</button>
                <button onClick={() => setTool('pen')} className={`px-3 py-1 text-sm rounded ${tool === 'pen' ? 'bg-purple-600 text-white' : 'bg-gray-300'}`}>Pencil</button>
                <button onClick={() => setTool('text')} className={`px-3 py-1 text-sm rounded ${tool === 'text' ? 'bg-yellow-600 text-white' : 'bg-gray-300'}`}>Text</button>
                <button onClick={() => setTool('eraser')} className={`px-3 py-1 text-sm rounded ${tool === 'eraser' ? 'bg-red-600 text-white' : 'bg-gray-300'}`}>Eraser</button>
                <button onClick={() => addShape('rect')} className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-1 px-3 rounded text-sm">Add Rectangle</button>
                <button onClick={() => addShape('circle')} className="bg-green-500 hover:bg-green-700 text-white font-bold py-1 px-3 rounded text-sm">Add Circle</button>
            </div>

            <div className="w-full h-full flex-grow bg-white relative" ref={containerRef}>
                {isLoading ? <p className="p-4">Loading whiteboard...</p> : (
                    <Stage
                        width={width} height={height}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        className={
                            tool === 'pen' ? 'cursor-crosshair' :
                                tool === 'text' ? 'cursor-text' :
                                    tool === 'eraser' ? 'cursor-pointer' :
                                        'cursor-default'
                        }
                    >
                        <Layer>
                            {shapes.map((shape) => {
                                if (shape.type === 'line') {
                                    // Make lines clickable only when the eraser tool is active
                                    return <Line key={shape.id} {...shape} tension={0.5} lineCap="round" listening={tool === 'eraser'} onClick={() => tool === 'eraser' && handleDeleteShape(shape.id)} onTap={() => tool === 'eraser' && handleDeleteShape(shape.id)} />;
                                }
                                if (shape.type === 'text' && editingText?.id === shape.id) {
                                    return null; // Hide Konva text while editing
                                }
                                return (
                                    <DraggableShape
                                        key={shape.id}
                                        shape={shape}
                                        isSelected={shape.id === selectedId && tool === 'select'}
                                        onSelect={() => tool === 'select' && setSelectedId(shape.id)}
                                        onChange={updateAndSendShape}
                                        tool={tool}
                                        onDblClick={handleTextDblClick}
                                        onDelete={handleDeleteShape}
                                    />
                                );
                            })}
                        </Layer>
                    </Stage>
                )}
                {editingText && (
                    <textarea
                        value={editingText.text}
                        onChange={handleTextChange}
                        onBlur={handleTextEditEnd}
                        autoFocus
                        style={{
                            position: 'absolute',
                            top: `${(editingText.y || 0)}px`,
                            left: `${(editingText.x || 0)}px`,
                            width: `${editingText.width}px`,
                            height: `${editingText.height}px`,
                            fontSize: `${editingText.fontSize}px`,
                            border: '1px solid #666', margin: 0, padding: '2px', background: 'white',
                            color: 'black', resize: 'none', outline: 'none', fontFamily: 'sans-serif',
                            transformOrigin: 'left top', transform: `rotate(${editingText.rotation || 0}deg)`,
                        }}
                    />
                )}
            </div>
        </div>
    );
};

export default Whiteboard;