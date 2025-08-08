import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import ProtectedRoute from './components/ProtectedRoute';
import ProjectWorkspacePage from './pages/ProjectWorkspacePage'; 

// This component handles the root URL logic. It doesn't need any changes.
function Root() {
  const { isAuthenticated } = useAuth();
  // If user is logged in, go to dashboard, otherwise go to login
  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />;
}

function App() {
  return (
    <AuthProvider>
      {/* This outer div applies the full-height and background color for the whole app */}
      <div className="flex flex-col h-screen bg-gray-800 text-white">
        <Router>
          {/* The <nav> element is styled with Tailwind classes */}
          <nav className="p-2 bg-gray-900 text-gray-300 flex-shrink-0 flex gap-4">
            {/* The <Link> elements are styled for better interaction */}
            <Link to="/login" className="hover:text-blue-600">Login</Link>
            <Link to="/register" className="hover:text-blue-600">Register</Link>
            <Link to="/dashboard" className="hover:text-blue-600">Dashboard (Protected)</Link>
          </nav>
          
          {/* This container ensures the routed content can also be full-height */}
          <div className="flex-grow">
            <Routes>
              <Route path="/" element={<Root />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              
              {/* Protected Routes */}
              <Route element={<ProtectedRoute />}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />
              </Route>
            </Routes>
          </div>
        </Router>
      </div>
    </AuthProvider>
  );
}

export default App;