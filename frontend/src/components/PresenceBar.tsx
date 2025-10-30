
import React from 'react';
import { type UserPresence } from '../types';
import { FiMic, FiMicOff, FiUserPlus } from 'react-icons/fi';

// NEW: Added props to handle voice chat state and actions
interface PresenceBarProps {
    users: UserPresence[];
    isInCall: boolean;
    onJoinLeaveCall: () => void;
    // --- NEW PROPS ---
    canInvite: boolean; // To control visibility
    onInviteClick: () => void;
}

const PresenceBar: React.FC<PresenceBarProps> = ({ users, isInCall, onJoinLeaveCall, canInvite, onInviteClick }) => {
    return (
        <div className="flex justify-between items-center p-2 bg-gray-700 rounded-lg min-h-[48px]">
            <div className="flex gap-3 items-center">
                <strong className="text-sm font-bold text-gray-200">Online:</strong>
                {users.map(user => (
                    <div
                        key={user.userId}
                        title={user.username}
                        className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold uppercase text-sm ring-2 ring-gray-600"
                    >
                        {user.username.substring(0, 2)}
                    </div>
                ))}
                {users.length === 0 && <span className="text-sm italic text-gray-400">Just you</span>}
            </div><div className="flex items-center gap-3">
                {canInvite && (
                    <button
                        onClick={onInviteClick}
                        title="Invite to project"
                        className="flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-md transition-colors bg-teal-600 hover:bg-teal-700 text-white"
                    >
                        <FiUserPlus />
                        Invite
                    </button>
                )}

                {/* NEW: Join/Leave Voice Chat Button */}
                <button
                    onClick={onJoinLeaveCall}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-md transition-colors ${isInCall
                            ? 'bg-red-600 hover:bg-red-700 text-white'
                            : 'bg-green-600 hover:bg-green-700 text-white'
                        }`}
                >
                    {isInCall ? <FiMicOff /> : <FiMic />}
                    {isInCall ? 'Leave Call' : 'Join Voice'}
                </button>
            </div>
        </div>
    );
};

export default PresenceBar;