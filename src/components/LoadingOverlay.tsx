import React from "react";

interface LoadingOverlayProps {
  message?: string;
  visible: boolean;
}

const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ message = "Cargando datos...", visible }) => {
  if (!visible) return null;

  return (
    <div className="loading-overlay">
      <div className="loading-overlay-card">
        <div className="loading-spinner">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#00B050" strokeWidth="2">
            <path d="M21 12a9 9 0 11-6.219-8.56" />
          </svg>
        </div>
        <p className="loading-message">{message}</p>
      </div>
    </div>
  );
};

export default LoadingOverlay;
