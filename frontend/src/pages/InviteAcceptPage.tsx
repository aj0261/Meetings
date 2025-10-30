import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import apiClient from '../api/axios';
import { useAuth } from '../contexts/AuthContext';

const InviteAcceptPage: React.FC = () => {
    const { inviteCode } = useParams<{ inviteCode: string }>();
    const navigate = useNavigate();
    const { isAuthenticated } = useAuth();
    const [status, setStatus] = useState('Accepting invitation...');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isAuthenticated) {
            // If the user isn't logged in, we can't accept the invite.
            // Store the invite code and redirect to login.
            localStorage.setItem('pendingInviteCode', inviteCode || '');
            navigate('/login');
            return;
        }

        const acceptInvite = async () => {
            try {
                const response = await apiClient.post('/invites/accept', { inviteCode });
                const { projectId } = response.data;
                setStatus('Successfully joined project! Redirecting...');
                // Redirect user to the project they just joined
                setTimeout(() => navigate(`/projects/${projectId}`), 2000);
            } catch (err: any) {
                setError(err.response?.data || 'Failed to accept invite. It may be invalid or expired.');
            }
        };

        acceptInvite();
    }, [isAuthenticated, inviteCode, navigate]);

    return (
        <div style={{ textAlign: 'center', margin: '50px' }}>
            <h2>Project Invitation</h2>
            {error ? (
                <p style={{ color: 'red' }}>Error: {error}</p>
            ) : (
                <p>{status}</p>
            )}
        </div>
    );
};

export default InviteAcceptPage;