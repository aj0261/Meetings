// src/components/WebRTCCall.tsx
import React, { useEffect, useRef, useState } from 'react';
import { type WsMessage } from '../hooks/useWebSocket';

interface RemoteStream {
    id: string;
    stream: MediaStream;
}

const AudioPlayer: React.FC<{ stream: MediaStream }> = ({ stream }) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.srcObject = stream;
            audioRef.current.play().catch(error => {
                console.warn("Audio play prevented by browser.", error);
            });
        }
    }, [stream]);
    return <audio ref={audioRef} autoPlay playsInline />;
};

interface WebRTCCallProps {
    userId: string;
    messages: WsMessage[];
    sendMessage: (msg: WsMessage) => void;
    onCallEnd: () => void;
}

export const WebRTCCall: React.FC<WebRTCCallProps> = ({ messages, sendMessage, onCallEnd, userId }) => {
    const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const localStreamRef = useRef<MediaStream | null>(null);

    // Store ICE candidates that arrive before PC is ready
    const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

    useEffect(() => {
        const startCall = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                localStreamRef.current = stream;
                sendMessage({ type: "webrtc_join", payload: {} });
                console.log("WebRTCCall: Sent join message, waiting for SFU offer...");
            } catch (error) {
                console.error("WebRTCCall: Could not get user media", error);
                onCallEnd();
            }
        };
        startCall();

        return () => {
            console.log("WebRTCCall: Cleaning up component.");
            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => track.stop());
            }
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
        };
    }, []);

    useEffect(() => {
        const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        if (!latestMessage) return;

        const handleOffer = async (payload: { sender: string, data: RTCSessionDescriptionInit }) => {
            console.log("WebRTCCall: Received offer from SFU");

            peerConnectionRef.current = new RTCPeerConnection();

            peerConnectionRef.current.oniceconnectionstatechange = () => {
                if (peerConnectionRef.current) {
                    console.log(`%cICE Connection State: ${peerConnectionRef.current.iceConnectionState}`, 'color: yellow');
                }
            };

            peerConnectionRef.current.ontrack = (event) => {
                const stream = event.streams[0];
                if (!stream) return;
                console.log(`%cSUCCESS: Received remote track, stream id: ${stream.id}`, 'color: lightgreen; font-weight: bold;');
                setRemoteStreams(prev => {
                    if (prev.some(s => s.id === stream.id)) return prev;
                    return [...prev, { id: stream.id, stream: stream }];
                });
            };

            peerConnectionRef.current.onicecandidate = (event) => {
                if (event.candidate) {
                    sendMessage({
                        type: 'webrtc_ice_candidate',
                        payload: { target: 'sfu', sender: userId, data: event.candidate.toJSON() }
                    });
                }
            };

            if (localStreamRef.current) {
                localStreamRef.current.getTracks().forEach(track => {
                    peerConnectionRef.current?.addTrack(track, localStreamRef.current!);
                });
            }

            try {
                await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(payload.data));
                const answer = await peerConnectionRef.current.createAnswer();
                await peerConnectionRef.current.setLocalDescription(answer);

                // Apply any ICE candidates that arrived early
                while (pendingCandidatesRef.current.length > 0) {
                    const candidateInit = pendingCandidatesRef.current.shift();
                    if (candidateInit) {
                        try {
                            await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidateInit));
                        } catch (err) {
                            console.error("Error adding buffered ICE candidate:", err);
                        }
                    }
                }

                sendMessage({
                    type: 'webrtc_answer',
                    payload: { target: 'sfu', sender: userId, data: answer }
                });
            } catch (error) {
                console.error("Error during offer/answer exchange:", error);
            }
        };

        const handleIceCandidate = (payload: { sender: string, data: RTCIceCandidateInit }) => {
            if (!payload.data || !payload.data.candidate || !payload.data.sdpMid) {
                return;
            }

            // Always buffer until PC exists + remote description is set
            if (!peerConnectionRef.current || !peerConnectionRef.current.remoteDescription) {
                pendingCandidatesRef.current.push(payload.data);
                return;
            }

            peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(payload.data))
                .catch(e => console.error("Error adding ICE candidate:", e));
        };

        switch (latestMessage.type) {
            case 'webrtc_offer':
                handleOffer(latestMessage.payload);
                break;
            case 'webrtc_ice_candidate':
                handleIceCandidate(latestMessage.payload);
                break;
        }
    }, [messages, sendMessage]);

    return (
        <div id="remote-audio-container">
            {remoteStreams.map(({ id, stream }) => (
                <AudioPlayer key={id} stream={stream} />
            ))}
        </div>
    );
};
