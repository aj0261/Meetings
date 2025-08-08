import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthForm from '../components/AuthForm';
import apiClient from '../api/axios';

const RegisterPage: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const handleRegister = async (formData: any) => {
    try {
      await apiClient.post('/auth/register', {
        username: formData.username,
        email: formData.email,
        password: formData.password,
      });
      // After successful registration, redirect to login page
      navigate('/login');
    } catch (err: any) {
      setError(err.response?.data || 'Registration failed. Please try again.');
    }
  };

  return <AuthForm isLogin={false} onSubmit={handleRegister} error={error} />;
};

export default RegisterPage;