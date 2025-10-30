import { useEffect, useRef, useState } from 'react';

export interface WsMessage {
  type: string;
  payload: any;
}

const useWebSocket = (projectId: string | undefined) => {
  const [messages, setMessages] = useState<WsMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!projectId) return;

    const token = localStorage.getItem('token');
    if (!token) {
      console.error("No auth token found. Cannot connect to WebSocket.");
      return;
    }

    // CORRECTED URL: This now matches our new top-level route in main.go
    const wsUrlBase = import.meta.env.VITE_WS_URL || 'ws://localhost:8080';
    const wsUrl = `${wsUrlBase}/ws/${projectId}?auth_token=${token}`;

    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      console.log("WebSocket connected!");
      setIsConnected(true);
    };

    ws.current.onclose = () => {
      console.log("WebSocket disconnected.");
      setIsConnected(false);
    };

    ws.current.onmessage = (event) => {
      try {
        const messageData = JSON.parse(event.data) as WsMessage;
        setMessages((prevMessages) => [...prevMessages, messageData]);
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    ws.current.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, [projectId]);

  const sendMessage = (message: object) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(message));
    }
  };

  return { messages, sendMessage, isConnected };
};

export default useWebSocket;