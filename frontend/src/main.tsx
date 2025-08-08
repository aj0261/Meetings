import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import Modal from 'react-modal'; 
import './index.css' 
import 'react-contexify/dist/ReactContexify.css';

Modal.setAppElement('#root');
ReactDOM.createRoot(document.getElementById('root')!).render(
    <App />
)