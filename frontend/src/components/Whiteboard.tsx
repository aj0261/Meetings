import React, { useCallback, useState, useEffect, useRef, memo } from 'react';
import { Stage, Layer, Rect, Circle, Transformer, Line, Text } from 'react-konva';
import Konva from 'konva';
import { v4 as uuidv4 } from 'uuid';
import useMeasure from 'react-use-measure';
import { type WsMessage } from '../hooks/useWebSocket'; // Assuming this path is correct
import apiClient from '../api/axios'; // Assuming this path is correct

// --- INTERFACES ---
interface Shape {
  id: string;
  type: 'rect' | 'circle' | 'line' | 'text';
  // Common properties
  x?: number;
  y?: number;
  rotation?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  // Type-specific properties
  text?: string;
  fontSize?: number;
  points?: number[];
  width?: number;
  height?: number;
  radius?: number;
}

interface WhiteboardProps {
  projectId: string | undefined;
  sendMessage: (message: object) => void;
  messages: WsMessage[];
  isReadOnly : boolean,
}

interface MemoizedShapeProps {
  shape: Shape;
  isSelected: boolean;
  onSelect: () => void;
  onChange: (newAttrs: Shape) => void;
  onDelete: (id: string) => void;
  onDblClick: (shape: Shape) => void;
  tool: 'select' | 'pen' | 'text' | 'eraser';
  onShapeDragStart: () => void; // <-- NEW PROP
  onShapeDragEnd: () => void;   // <-- NEW PROP
  isDraggable: boolean;
}


// --- MEMOIZED SHAPE COMPONENT (CORRECTED) ---
// Now handles all shape types, including 'line'.
const MemoizedShape = memo(({ shape, isSelected, isDraggable, onSelect, onChange, onDelete, onDblClick, tool, onShapeDragStart, onShapeDragEnd }: MemoizedShapeProps) => {
  const shapeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  useEffect(() => {
    // Only attach transformer to selected nodes that are not lines
    if (isSelected && trRef.current && shape.type !== 'line') {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected, shape.type]);

  const handleTransformEnd = () => {
    const node = shapeRef.current;
    if (!node) return;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);

    let newAttrs: any = { ...shape, x: node.x(), y: node.y(), rotation: node.rotation() };
    if (shape.type === 'rect' || shape.type === 'text') {
      newAttrs.width = Math.max(5, (shape.width || 0) * scaleX);
      newAttrs.height = Math.max(5, (shape.height || 0) * scaleY);
    } else if (shape.type === 'circle') {
      newAttrs.radius = Math.max(5, (shape.radius || 0) * Math.max(scaleX, scaleY));
    }
    onChange(newAttrs);
  };

  const shapeProps = {
    ref: shapeRef, ...shape,
    draggable: isDraggable, 
    onDragStart: (e: Konva.KonvaEventObject<DragEvent>) => {
      onShapeDragStart();
      e.cancelBubble = true;
    },
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => {
      onShapeDragEnd();
      onChange({ ...shape, x: e.target.x(), y: e.target.y() });
    },

    onClick: (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (tool === 'eraser') {
        onDelete(shape.id);
      } else if (tool === 'select') {
        onSelect();
        e.cancelBubble = true;
      }
    },
    onTap: (e: Konva.KonvaEventObject<TouchEvent>) => {
      if (tool === 'eraser') {
        onDelete(shape.id);
      } else if (tool === 'select') {
        onSelect();
        e.cancelBubble = true;
      }
    },
    onTransformEnd: handleTransformEnd,
    onDblClick: () => onDblClick(shape),
    onDblTap: () => onDblClick(shape),
  };

  let shapeComponent;
  switch (shape.type) {
    case 'rect': shapeComponent = <Rect {...shapeProps} />; break;
    case 'circle': shapeComponent = <Circle {...shapeProps} />; break;
    case 'text': shapeComponent = <Text {...shapeProps} />; break;
    // FIX: Added case for 'line' to make them interactive
    case 'line': shapeComponent = <Line {...shapeProps} tension={0.5} lineCap="round" strokeScaleEnabled={false} />; break;
    default: return null;
  }

  return (
    <>
      {shapeComponent}
      {/* FIX: Transformer is only shown for resizable shapes (not lines) */}
      {isSelected && shape.type !== 'line' && (
        <Transformer ref={trRef} boundBoxFunc={(oldBox, newBox) => (newBox.width < 5 || newBox.height < 5) ? oldBox : newBox} />
      )}
    </>
  );
});


// --- MAIN WHITEBOARD COMPONENT (CORRECTED) ---
const Whiteboard: React.FC<WhiteboardProps> = ({ projectId, sendMessage, messages ,isReadOnly}) => {
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<'select' | 'pen' | 'text' | 'eraser'>('select');
  const [isLoading, setIsLoading] = useState(true);
  const [containerRef, { width, height }] = useMeasure();
  const stageRef = useRef<Konva.Stage>(null);
  const isDrawing = useRef(false);
  const lastUpdateTime = useRef(0);
  const [editingText, setEditingText] = useState<Shape | null>(null);
  const textUpdateTimeout = useRef<number | null>(null);
  const [stageState, setStageState] = useState({ scale: 1, x: 0, y: 0 });
  const processedMessagesCount = useRef(0); // FIX: To track processed messages
  const [isDraggingShape, setIsDraggingShape] = useState(false); // <-- NEW STATE
  const hasLoadedInitialState = useRef(false);

  // --- Data Fetching and WebSocket Handling ---
  useEffect(() => {
    if (!projectId) return;
    setIsLoading(true);
    hasLoadedInitialState.current = false;
    apiClient.get(`/project/${projectId}/whiteboardState`).then(res => {
      setShapes(res.data.shapes || []);
      setIsLoading(false);
    }).catch(err => { console.error('Failed to fetch whiteboard state', err); setIsLoading(false); });
  }, [projectId]);

  // FIX: Robust WebSocket message handling to prevent lost messages
  useEffect(() => {
    const newMessages = messages.slice(processedMessagesCount.current);
    if (newMessages.length === 0) return;

    setShapes(currentShapes => {
      let shapesCopy = [...currentShapes];
      const shapesMap = new Map(shapesCopy.map(s => [s.id, s]));

      newMessages.forEach(message => {
        const { type, payload } = message;
        if (type === 'whiteboard_update') {
          shapesMap.set(payload.shape.id, payload.shape);
        } else if (type === 'whiteboard_object_remove') {
          shapesMap.delete(payload.id);
        }
      });
      return Array.from(shapesMap.values());
    });

    processedMessagesCount.current = messages.length;
  }, [messages]);

  const zoomStage = useCallback((newScale: number, pivot: { x: number, y: number }) => {
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = stage.scaleX();
    const mousePointTo = {
      x: (pivot.x - stage.x()) / oldScale,
      y: (pivot.y - stage.y()) / oldScale,
    };

    // Clamp the new scale to reasonable limits (e.g., 20% to 300%)
    const clampedScale = Math.max(0.2, Math.min(newScale, 3.0));

    setStageState({
      scale: clampedScale,
      x: pivot.x - mousePointTo.x * clampedScale,
      y: pivot.y - mousePointTo.y * clampedScale,
    });
  }, []); // Empty dependency array as it doesn't depend on external state


  // --- Core Action Handlers ---
  const updateAndSendShape = (updatedShape: Shape) => {
    setShapes(prev => prev.map(s => s.id === updatedShape.id ? updatedShape : s));
    sendMessage({ type: 'whiteboard_update', payload: { shape: updatedShape } });
  };

  const handleDeleteShape = (idToDelete: string) => {
    setShapes(current => current.filter(s => s.id !== idToDelete));
    sendMessage({ type: 'whiteboard_object_remove', payload: { id: idToDelete } });
  };

  const addShape = (type: 'rect' | 'circle') => {
    const stage = stageRef.current;
    if (!stage) return;
    const centerX = (stage.width() / 2 - stage.x()) / stage.scaleX();
    const centerY = (stage.height() / 2 - stage.y()) / stage.scaleY();
    const newShape: Shape = type === 'rect' ? {
      id: uuidv4(), type: 'rect', x: centerX, y: centerY, width: 120, height: 80, fill: 'white', stroke: 'black', strokeWidth: 2
    } : {
      id: uuidv4(), type: 'circle', x: centerX, y: centerY, radius: 50, fill: 'white', stroke: 'black', strokeWidth: 2
    };
    setShapes(prev => [...prev, newShape]);
    sendMessage({ type: 'whiteboard_update', payload: { shape: newShape } });
  };

  // --- Mouse and Pan/Zoom Event Handlers ---
  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    if (editingText) return;
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.05;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;

    zoomStage(newScale, pointer);
  };

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.target !== stageRef.current) return;

    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;

    if (tool === 'pen') {
      isDrawing.current = true;
      const newLine: Shape = {
        id: uuidv4(), type: 'line', points: [pos.x, pos.y],
        stroke: '#000', strokeWidth: 5,
      };
      setShapes(prev => [...prev, newLine]);
    } else if (tool === 'text') { // FIX: Added text creation logic
      const newText: Shape = {
        id: uuidv4(), type: 'text', x: pos.x, y: pos.y,
        text: 'New Text', fontSize: 24, fill: 'black',
      };
      setShapes(prev => [...prev, newText]);
      sendMessage({ type: 'whiteboard_update', payload: { shape: newText } });
      setTool('select'); // Switch to select tool for better UX
    } else {
      setSelectedId(null);
    }
  };

  const handleMouseMove = () => {
    if (!isDrawing.current || tool !== 'pen') return;
    const stage = stageRef.current;
    if (!stage) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;

    setShapes(currentShapes => {
      const lastLine = currentShapes[currentShapes.length - 1];
      if (lastLine?.type === 'line') {
        lastLine.points = (lastLine.points || []).concat([pos.x, pos.y]);
        return currentShapes.slice();
      }
      return currentShapes;
    });

    const now = Date.now();
    if (now - lastUpdateTime.current > 50) {
      lastUpdateTime.current = now;
      const lastLine = shapes[shapes.length - 1];
      if (lastLine) {
        sendMessage({ type: 'whiteboard_update', payload: { shape: lastLine } });
      }
    }
  };

  const handleMouseUp = () => {
    isDrawing.current = false;
    const lastLine = shapes[shapes.length - 1];
    if (lastLine?.type === 'line' && lastLine.points && lastLine.points.length > 2) {
      sendMessage({ type: 'whiteboard_update', payload: { shape: lastLine } });
    }
  };

  // --- Text Editing Handlers ---
  const handleTextDblClick = (shape: Shape) => {
    if (shape.type === 'text') {
      setSelectedId(null); // Deselect to hide transformer
      setEditingText(shape);
    }
  };

  const handleTextEditEnd = () => {
    if (textUpdateTimeout.current) clearTimeout(textUpdateTimeout.current);
    if (editingText) updateAndSendShape(editingText);
    setEditingText(null);
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!editingText) return;
    const updatedText = { ...editingText, text: e.target.value };
    setEditingText(updatedText);

    if (textUpdateTimeout.current) clearTimeout(textUpdateTimeout.current);
    textUpdateTimeout.current = window.setTimeout(() => {
      updateAndSendShape(updatedText);
    }, 300);
  };

  // UX: Helper for cursor style
  const getCursorStyle = () => {
    switch (tool) {
      case 'pen': return 'cursor-crosshair';
      case 'eraser': return 'cursor-cell';
      case 'text': return 'cursor-text';
      default: return 'cursor-default';
    }
  };

  const handleZoomControl = (zoomDirection: 'in' | 'out' | 'reset' | 'value', value?: number) => {
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = stage.scaleX();
    const scaleBy = 1.2; // Use a larger factor for button clicks
    const center = { x: width / 2, y: height / 2 };

    let newScale = oldScale;
    if (zoomDirection === 'in') {
      newScale = oldScale * scaleBy;
    } else if (zoomDirection === 'out') {
      newScale = oldScale / scaleBy;
    } else if (zoomDirection === 'reset') {
      newScale = 1;
    } else if (zoomDirection === 'value' && value) {
      newScale = value;
    }

    zoomStage(newScale, center);
  }

  return (
    <div className="w-full h-full flex flex-col bg-gray-100">
      {/* Toolbar */}
      {!isReadOnly && ( 
      <div className="p-2 bg-gray-200 border-b border-gray-300 flex-shrink-0 flex items-center gap-2 flex-wrap">
        <button onClick={() => setTool('select')} className={`px-3 py-1 text-sm rounded ${tool === 'select' ? 'bg-blue-600 text-white' : 'bg-gray-300'}`}>Select</button>
        <button onClick={() => setTool('pen')} className={`px-3 py-1 text-sm rounded ${tool === 'pen' ? 'bg-purple-600 text-white' : 'bg-gray-300'}`}>Pencil</button>
        <button onClick={() => setTool('text')} className={`px-3 py-1 text-sm rounded ${tool === 'text' ? 'bg-yellow-600 text-white' : 'bg-gray-300'}`}>Text</button>
        <button onClick={() => setTool('eraser')} className={`px-3 py-1 text-sm rounded ${tool === 'eraser' ? 'bg-red-600 text-white' : 'bg-gray-300'}`}>Eraser</button>
        <div className="w-px h-6 bg-gray-400 mx-2"></div>
        <button onClick={() => addShape('rect')} className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-1 px-3 rounded text-sm">Add Rectangle</button>
        <button onClick={() => addShape('circle')} className="bg-green-500 hover:bg-green-700 text-white font-bold py-1 px-3 rounded text-sm">Add Circle</button>
      </div>
      )}

      {/* Canvas Area */}
      <div className="w-full h-full flex-grow bg-white relative" ref={containerRef}>
        {isLoading ? <p className="p-4 text-gray-500">Loading whiteboard...</p> : (
          <Stage
            ref={stageRef}
            width={width} height={height}
            onMouseDown={isReadOnly ? undefined :handleMouseDown}
            onMouseMove={isReadOnly ? undefined : handleMouseMove}
            onMouseUp={isReadOnly ? undefined :handleMouseUp}
            onWheel={handleWheel}
            scaleX={stageState.scale}
            scaleY={stageState.scale}
            x={stageState.x}
            y={stageState.y}
            draggable={tool === 'select' && !editingText && !isDraggingShape}
            onDragEnd={(e) => {
              if (e.target === stageRef.current) {
                setStageState({ ...stageState, x: e.target.x(), y: e.target.y() });
              }
            }}
            className={getCursorStyle()}
          >
            <Layer>
              {shapes.map((shape) => {
                // Don't render shape being edited, as the textarea covers it
                if (editingText?.id === shape.id) return null;
                // FIX: Use MemoizedShape for ALL shapes for consistent behavior
                return (
                  <MemoizedShape
                    key={shape.id}
                    shape={shape}
                    isSelected={shape.id === selectedId}
                    onSelect={() => setSelectedId(shape.id)}
                    onChange={updateAndSendShape}
                    onDelete={handleDeleteShape}
                    onDblClick={handleTextDblClick}
                    tool={tool}
                    onShapeDragStart={() => setIsDraggingShape(true)}
                    onShapeDragEnd={() => setIsDraggingShape(false)}
                    isDraggable={!isReadOnly && tool === 'select'}
                  />
                );
              })}
            </Layer>
          </Stage>
        )}
        {/* HTML Textarea for live editing */}
        {editingText && (
          <textarea
            value={editingText.text}
            onChange={handleTextChange}
            onBlur={handleTextEditEnd}
            autoFocus
            style={{
              position: 'absolute',
              top: `${stageState.y + ((editingText.y || 0) * stageState.scale)}px`,
              left: `${stageState.x + ((editingText.x || 0) * stageState.scale)}px`,
              width: `${(editingText.width || 150) * stageState.scale}px`,
              height: `${(editingText.height || 100) * stageState.scale}px`,
              fontSize: `${(editingText.fontSize || 24) * stageState.scale}px`,
              border: '1px solid #666',
              margin: 0,
              padding: '2px',
              background: 'white',
              color: 'black',
              resize: 'none',
              outline: 'none',
              fontFamily: 'sans-serif',
              transformOrigin: 'top left',
              transform: `rotate(${(editingText.rotation || 0)}deg)`,
            }}
          />
        )}
        {/* --- NEW: Zoom Controls UI --- */}
        {!isLoading && (
          <div className="absolute bottom-4 right-4 bg-white bg-opacity-80 backdrop-blur-sm p-2 rounded-lg shadow-md flex items-center gap-2 text-sm">
            <button title="Zoom Out" onClick={() => handleZoomControl('out')} className="w-7 h-7 flex items-center justify-center font-bold text-lg bg-gray-200 rounded hover:bg-gray-300">-</button>
            <input
              type="range"
              min="0.2"
              max="3"
              step="0.01"
              value={stageState.scale}
              onChange={(e) => handleZoomControl('value', e.target.valueAsNumber)}
              className="w-24"
            />
            <button title="Zoom In" onClick={() => handleZoomControl('in')} className="w-7 h-7 flex items-center justify-center font-bold text-lg bg-gray-200 rounded hover:bg-gray-300">+</button>
            <button title="Reset Zoom" onClick={() => handleZoomControl('reset')} className="w-16 h-7 text-xs bg-gray-200 rounded hover:bg-gray-300">
              {Math.round(stageState.scale * 100)}%
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Whiteboard;