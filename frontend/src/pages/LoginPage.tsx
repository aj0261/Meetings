import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthForm from '../components/AuthForm';
import apiClient from '../api/axios';
import { useAuth } from '../contexts/AuthContext';

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (formData: any) => {
    try {
      const response = await apiClient.post('/auth/login', {
        email: formData.email,
        password: formData.password,
      });
      const { user, token } = response.data;
      login(user, token);
      navigate('/dashboard'); // Redirect to a dashboard page after login
    } catch (err: any) {
      setError(err.response?.data || 'Login failed. Please try again.');
    }
  };

  return <AuthForm isLogin={true} onSubmit={handleLogin} error={error} />;
};

export default LoginPage;