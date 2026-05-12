import React, { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import './App.css';
import Sidebar from './components/Sidebar';
import InformesMensuales from './pages/InformesMensuales';
import GeneradorHashes from './pages/GeneradorHashes';

const App: React.FC = () => {
  const [notification, setNotification] = useState<{ msg: string; type: 'success' | 'error' | 'info' } | null>(null);

  const showNotification = (msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  };

  return (
    <div className="app-root">
      {/* Toast */}
      {notification && (
        <div className={`toast toast--${notification.type}`}>
          {notification.msg}
        </div>
      )}

      {/* Sidebar */}
      <Sidebar />

      {/* Main Content — Routes */}
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Navigate to="/informes" replace />} />
          <Route path="/informes" element={<InformesMensuales showNotification={showNotification} />} />
          <Route path="/hashes" element={<GeneradorHashes showNotification={showNotification} />} />
        </Routes>
      </main>
    </div>
  );
};

export default App;
