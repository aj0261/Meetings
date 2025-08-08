export interface UserPresence {
    userId: string;
    username: string;
}

export interface PresenceUpdatePayload {
    users: UserPresence[];
}
export interface EditorUpdatePayload {
    content: string;
}
// This will be the payload for any message that sends shape data.
// We send the full serialized object from Fabric.js.
export interface WhiteboardUpdatePayload {
    // The `any` type is appropriate here because the serialized object
    // from Fabric.js is complex and we don't need to type it strictly.
    shape: any; 
}