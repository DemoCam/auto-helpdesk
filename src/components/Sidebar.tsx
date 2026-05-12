import React from "react";
import { NavLink } from "react-router-dom";

const Sidebar: React.FC = () => {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </div>
        <span className="brand-text">Mesa de Ayuda</span>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section-title">HERRAMIENTAS</div>

        <NavLink
          to="/informes"
          className={({ isActive }) => `sidebar-nav-item ${isActive ? "sidebar-nav-item--active" : ""}`}
        >
          <div className="nav-item-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.21 15.89A10 10 0 118 2.83" />
              <path d="M22 12A10 10 0 0012 2v10z" />
            </svg>
          </div>
          <div className="nav-item-content">
            <span className="nav-item-label">Informes Mensuales</span>
            <span className="nav-item-desc">Indicadores SDP</span>
          </div>
        </NavLink>

        <NavLink
          to="/hashes"
          className={({ isActive }) => `sidebar-nav-item ${isActive ? "sidebar-nav-item--active" : ""}`}
        >
          <div className="nav-item-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          </div>
          <div className="nav-item-content">
            <span className="nav-item-label">Generador Hashes</span>
            <span className="nav-item-desc">SentinelOne Rules</span>
          </div>
        </NavLink>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-info">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.5 }}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          <span>Auto-Helpdesk v2.0</span>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
