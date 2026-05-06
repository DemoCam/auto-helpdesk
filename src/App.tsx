import React, { useState, useMemo, useCallback } from 'react';
import './App.css';
import { useReportStore, MONTH_NAMES } from './store/useReportStore';
import type { ReportRow } from './store/useReportStore';
import { parseCSV } from './utils/CSVParser';
import ChartCard from './components/ChartCard';
import { toPng } from 'html-to-image';
import JSZip from 'jszip';

/* ─── Color palette from PPTX ─── */
const PPTX_GREEN = '#00B050';

const PIE_GREENS = [
  '#0D4D2B', '#145E34', '#1B7040', '#22824D', '#2E9960',
  '#47B078', '#6DC495', '#93D4B0', '#B5E3C9', '#D6F1E2'
];

const MONTH_SHORT: Record<string, string> = {
  'Enero': 'Ene', 'Febrero': 'Feb', 'Marzo': 'Mar', 'Abril': 'Abr',
  'Mayo': 'May', 'Junio': 'Jun', 'Julio': 'Jul', 'Agosto': 'Ago',
  'Septiembre': 'Sep', 'Octubre': 'Oct', 'Noviembre': 'Nov', 'Diciembre': 'Dic'
};

const App: React.FC = () => {
  const { months, addMonth, clearAll, currentMonth, previousMonth, setCurrentMonth, setPreviousMonth } = useReportStore();
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notification, setNotification] = useState<{ msg: string, type: 'success' | 'error' | 'info' } | null>(null);
  const [showYearlyPrompt, setShowYearlyPrompt] = useState(false);
  const [showYearlyChart, setShowYearlyChart] = useState(false);

  const showNotification = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  }, []);

  // Auto-detect month from rows (assuming DD-MM-YYYY format in Fecha)
  const detectMonth = (rows: ReportRow[]): string | null => {
    for (const row of rows) {
      if (row.Fecha) {
        // e.g. "01-12-2025 10:15"
        const datePart = row.Fecha.split(' ')[0];
        const parts = datePart.split(/[-/]/);
        if (parts.length >= 2) {
          const mm = parseInt(parts[1], 10);
          if (mm >= 1 && mm <= 12) {
            return MONTH_NAMES[mm - 1]; // 0-indexed month array
          }
        }
      }
    }
    return null;
  };

  const processFiles = async (files: FileList | File[]) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    let loadedCount = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.name.endsWith('.csv')) continue;

        const rows = await parseCSV(file);
        const detectedMonth = detectMonth(rows);

        if (detectedMonth) {
          addMonth(detectedMonth, rows);
          showNotification(`✓ ${rows.length} registros cargados para ${detectedMonth}`, 'success');
          loadedCount++;
        } else {
          showNotification(`No se pudo detectar el mes para ${file.name}`, 'error');
        }
      }

      if (loadedCount > 0) {
        // Auto-select months based on loaded data (sorted by calendar order)
        const allLoadedMonths = useReportStore.getState().months.map(m => m.monthName);
        const sorted = MONTH_NAMES.filter(m => allLoadedMonths.includes(m));
        if (sorted.length >= 1) {
          setCurrentMonth(sorted[sorted.length - 1]); // most recent
        }
        if (sorted.length >= 2) {
          setPreviousMonth(sorted[sorted.length - 2]); // second most recent
        } else if (sorted.length === 1) {
          setPreviousMonth(sorted[0]); // same month if only one loaded
        }

        if (!showYearlyChart) {
          setShowYearlyPrompt(true);
        }
      }
    } catch (err) {
      showNotification(`Error: ${err}`, 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(e.target.files);
      e.target.value = '';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      processFiles(e.dataTransfer.files);
    }
  };

  /* ─── Data Access ─── */
  const currentMonthData = useMemo(() => months.find(m => m.monthName === currentMonth)?.rows || [], [months, currentMonth]);
  const prevMonthData = useMemo(() => months.find(m => m.monthName === previousMonth)?.rows || [], [months, previousMonth]);

  /* ─── YEARLY OVERVIEW DATA ─── */
  const yearlyData = useMemo(() => {
    return MONTH_NAMES.map(monthName => {
      const monthData = months.find(m => m.monthName === monthName);
      if (!monthData) return { month: monthName, short: MONTH_SHORT[monthName], total: 0, solicitudes: 0, incidentes: 0, loaded: false };
      const rows = monthData.rows;
      return {
        month: monthName,
        short: MONTH_SHORT[monthName],
        total: rows.length,
        solicitudes: rows.filter(r => r.Tipo === 'Solicitud de Servicio').length,
        incidentes: rows.filter(r => r.Tipo === 'Incidente').length,
        loaded: true
      };
    });
  }, [months]);

  const loadedYearlyData = useMemo(() => yearlyData.filter(d => d.loaded), [yearlyData]);
  const missingMonths = useMemo(() => yearlyData.filter(d => !d.loaded).map(d => d.month), [yearlyData]);

  /* ─── 1. Casos Área de Sistemas (General by Categoría) ─── */
  const getAppStats = (data: ReportRow[]) => {
    const counts: Record<string, number> = {};
    data.forEach(row => {
      const cat = row.Categoria || 'No asignado';
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  /* ─── 2. Incidentes por Categoría ─── */
  const getIncStats = (data: ReportRow[]) => {
    const inc = data.filter(r => r.Tipo === 'Incidente');
    const counts: Record<string, number> = {};
    inc.forEach(row => { counts[row.Categoria] = (counts[row.Categoria] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  /* ─── 3. Solicitudes de Servicio por Categoría ─── */
  const getReqStats = (data: ReportRow[]) => {
    const req = data.filter(r => r.Tipo === 'Solicitud de Servicio');
    const counts: Record<string, number> = {};
    req.forEach(row => { counts[row.Categoria] = (counts[row.Categoria] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  /* ─── 4. Solicitud de Información por Categoría ─── */
  const getSolInfoStats = (data: ReportRow[]) => {
    const solInfo = data.filter(r => r.Tipo === 'Solicitud de Información');
    const counts: Record<string, number> = {};
    solInfo.forEach(row => { counts[row.Categoria] = (counts[row.Categoria] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  /* ─── 5. Analysis: Top 10 subcategories ─── */
  const getTop10 = (data: ReportRow[]) => {
    const counts: Record<string, number> = {};
    data.forEach(row => {
      const key = row.Subcategoria || 'No asignado';
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  };

  /* ─── 6. Métricas por Técnico — FIXED LOGIC ─── */
  const getTecStats = (data: ReportRow[]) => {
    const tecs = Array.from(new Set(data.map(r => r.Tecnico).filter(Boolean)));
    return tecs.map(tec => {
      const tecRows = data.filter(r => r.Tecnico === tec);
      const total = tecRows.length;

      const solOnTime = tecRows.filter(r => {
        const val = (r.TiempoSolucion || '').toLowerCase().trim();
        return val === 'false';
      }).length;

      const ateOnTime = tecRows.filter(r => {
        const val = (r.TiempoAtencion || '').toLowerCase().trim();
        return val === 'false';
      }).length;

      const solOverdue = tecRows.filter(r => {
        const val = (r.TiempoSolucion || '').toLowerCase().trim();
        return val === 'true';
      }).length;

      const ateOverdue = tecRows.filter(r => {
        const val = (r.TiempoAtencion || '').toLowerCase().trim();
        return val === 'true';
      }).length;

      const solTotal = solOnTime + solOverdue;
      const ateTotal = ateOnTime + ateOverdue;
      const solRate = solTotal > 0 ? Math.round((solOnTime / solTotal) * 100) : 100;
      const ateRate = ateTotal > 0 ? Math.round((ateOnTime / ateTotal) * 100) : 100;

      return {
        tec,
        total,
        solRate,
        ateRate,
        solOnTime,
        solOverdue,
        ateOnTime,
        ateOverdue
      };
    }).sort((a, b) => b.total - a.total);
  };

  /* ─── 7. Cases by Estado ─── */
  const getEstadoStats = (data: ReportRow[]) => {
    const counts: Record<string, number> = {};
    data.forEach(row => {
      const estado = row.Estado || 'No definido';
      counts[estado] = (counts[estado] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  /* ─── 8. Analysis: Comparison table by category ─── */
  const getCategoryComparison = (prev: ReportRow[], curr: ReportRow[]) => {
    const categories = new Set<string>();
    prev.forEach(r => categories.add(r.Categoria));
    curr.forEach(r => categories.add(r.Categoria));

    const result = Array.from(categories)
      .filter(cat => cat && cat !== 'No asignado')
      .map(cat => {
        const prevCount = prev.filter(r => r.Categoria === cat).length;
        const currCount = curr.filter(r => r.Categoria === cat).length;
        return { cat, prev: prevCount, curr: currCount, diff: currCount - prevCount };
      })
      .sort((a, b) => b.curr - a.curr);
    return result;
  };

  /* ─── Computed stats ─── */
  const appStats = useMemo(() => getAppStats(currentMonthData), [currentMonthData]);
  const incStats = useMemo(() => getIncStats(currentMonthData), [currentMonthData]);
  const reqStats = useMemo(() => getReqStats(currentMonthData), [currentMonthData]);
  const solInfoStats = useMemo(() => getSolInfoStats(currentMonthData), [currentMonthData]);
  const top10 = useMemo(() => getTop10(currentMonthData), [currentMonthData]);
  const tecStats = useMemo(() => getTecStats(currentMonthData), [currentMonthData]);
  const estadoStats = useMemo(() => getEstadoStats(currentMonthData), [currentMonthData]);
  const catComparison = useMemo(() => getCategoryComparison(prevMonthData, currentMonthData), [prevMonthData, currentMonthData]);
  const prevIncStats = useMemo(() => getIncStats(prevMonthData), [prevMonthData]);
  const prevTecStats = useMemo(() => getTecStats(prevMonthData), [prevMonthData]);

  /* ─── Merged technician list (union of both months, sorted by current total) ─── */
  const mergedTecNames = useMemo(() => {
    const allNames = new Set<string>();
    tecStats.forEach(s => allNames.add(s.tec));
    prevTecStats.forEach(s => allNames.add(s.tec));
    return Array.from(allNames).sort((a, b) => {
      const aCurr = tecStats.find(s => s.tec === a)?.total || 0;
      const bCurr = tecStats.find(s => s.tec === b)?.total || 0;
      return bCurr - aCurr;
    });
  }, [tecStats, prevTecStats]);

  const shortTecName = (name: string) => {
    const parts = name.split(' ');
    return parts.length > 2 ? `${parts[0]} ${parts[1].charAt(0)}.` : name.length > 12 ? name.substring(0, 10) + '.' : name;
  };

  /* ─── Yearly SLA data (Atención + Solución per month) ─── */
  const yearlySLAData = useMemo(() => {
    return MONTH_NAMES.map(monthName => {
      const monthData = months.find(m => m.monthName === monthName);
      if (!monthData) return { month: monthName, short: MONTH_SHORT[monthName], ateRate: 0, solRate: 0, loaded: false };
      const rows = monthData.rows;
      const ateOnTime = rows.filter(r => (r.TiempoAtencion || '').toLowerCase().trim() === 'false').length;
      const ateOverdue = rows.filter(r => (r.TiempoAtencion || '').toLowerCase().trim() === 'true').length;
      const solOnTime = rows.filter(r => (r.TiempoSolucion || '').toLowerCase().trim() === 'false').length;
      const solOverdue = rows.filter(r => (r.TiempoSolucion || '').toLowerCase().trim() === 'true').length;
      const ateTotal = ateOnTime + ateOverdue;
      const solTotal = solOnTime + solOverdue;
      return {
        month: monthName,
        short: MONTH_SHORT[monthName],
        ateRate: ateTotal > 0 ? Math.round((ateOnTime / ateTotal) * 100) : 0,
        solRate: solTotal > 0 ? Math.round((solOnTime / solTotal) * 100) : 0,
        loaded: true
      };
    });
  }, [months]);

  /* ─── Export ─── */
  const exportAll = async () => {
    setExporting(true);
    try {
      const zip = new JSZip();
      const cards = document.querySelectorAll('.chart-card, .table-card');
      for (const card of Array.from(cards)) {
        try {
          const dataUrl = await toPng(card as HTMLElement, { backgroundColor: '#ffffff', pixelRatio: 2 });
          const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
          const name = card.id || `element_${Date.now()}`;
          zip.file(`${name}.png`, base64Data, { base64: true });
        } catch { /* skip failed card */ }
      }
      const content = await zip.generateAsync({ type: "blob" });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `Reporte_Gestion_${currentMonth}.zip`;
      link.click();
      showNotification('✓ Archivo ZIP descargado exitosamente', 'success');
    } catch {
      showNotification('Error al generar el ZIP', 'error');
    } finally {
      setExporting(false);
    }
  };

  const totalCurrent = currentMonthData.length;
  const totalPrev = prevMonthData.length;
  const totalInc = currentMonthData.filter(r => r.Tipo === 'Incidente').length;
  const totalReq = currentMonthData.filter(r => r.Tipo === 'Solicitud de Servicio').length;
  const totalSolInfo = currentMonthData.filter(r => r.Tipo === 'Solicitud de Información').length;
  const loadedMonths = months.map(m => m.monthName);

  return (
    <div className="app-root">
      {/* Notification toast */}
      {notification && (
        <div className={`toast toast--${notification.type}`}>
          {notification.msg}
        </div>
      )}

      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
          </div>
          <span className="brand-text">Mesa de Ayuda</span>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-title">CONFIGURACIÓN</div>

          <div className="sidebar-field">
            <label>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
              Mes Actual
            </label>
            <select value={currentMonth} onChange={e => setCurrentMonth(e.target.value)} disabled={loadedMonths.length === 0}>
              {loadedMonths.length === 0 ? (
                <option value="">Sin datos cargados</option>
              ) : (
                loadedMonths.map(m => <option key={m} value={m}>{m}</option>)
              )}
            </select>
          </div>

          <div className="sidebar-field">
            <label>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
              Mes Anterior
            </label>
            <select value={previousMonth} onChange={e => setPreviousMonth(e.target.value)} disabled={loadedMonths.length === 0}>
              {loadedMonths.length === 0 ? (
                <option value="">Sin datos cargados</option>
              ) : (
                loadedMonths.map(m => <option key={m} value={m}>{m}</option>)
              )}
            </select>
          </div>

          <div className="nav-section-title" style={{ marginTop: '16px' }}>CARGAR DATOS</div>

          <div
            className={`dropzone ${isDragging ? 'dropzone--active' : ''} ${isUploading ? 'dropzone--uploading' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="dropzone-icon">
              {isUploading ? (
                <svg className="spinner" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 11-6.219-8.56" /></svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
              )}
            </div>
            <p className="dropzone-text">
              {isUploading ? 'Procesando archivos...' : 'Arrastra tus archivos CSV aquí (Múltiples)'}
            </p>
            {!isUploading && (
              <>
                <span className="dropzone-or">o</span>
                <label className="dropzone-btn">
                  Seleccionar archivos
                  <input type="file" accept=".csv" multiple onChange={handleFileUpload} />
                </label>
              </>
            )}
            <small className="dropzone-hint">El mes se detectará automáticamente</small>
          </div>

          {/* Loaded months indicator */}
          {loadedMonths.length > 0 && (
            <div className="loaded-months">
              <div className="nav-section-title">MESES CARGADOS</div>
              {months.map(m => (
                <div key={m.monthName} className="loaded-month-tag">
                  <span className="month-dot"></span>
                  {m.monthName} ({m.rows.length})
                </div>
              ))}
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <button className="btn-clear" onClick={clearAll} disabled={months.length === 0}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
            Limpiar Todo
          </button>
          <button className="btn-export" onClick={exportAll} disabled={months.length === 0 || exporting}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            {exporting ? 'Exportando...' : 'Descargar ZIP'}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <header className="main-header">
          <div className="header-left">
            <h1>INDICADORES DE MESA DE AYUDA</h1>
            <p className="header-subtitle">Informe de Gestión</p>
          </div>
          <div className="header-right">
            <div className="header-logo">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#00B050" /><path d="M7 12l3 3 7-7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
          </div>
        </header>

        {months.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#00B050" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>
            </div>
            <h2>Sin datos cargados</h2>
            <p>Selecciona un mes y sube un archivo CSV de Proactivanet para generar los indicadores automáticamente.</p>
          </div>
        ) : (
          <>
            {/* ═══ YEARLY OVERVIEW PROMPT ═══ */}
            {showYearlyPrompt && !showYearlyChart && (
              <div className="yearly-prompt">
                <div className="yearly-prompt-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00B050" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                </div>
                <div className="yearly-prompt-body">
                  <strong>Gráfico Anual disponible</strong>
                  <p>Tienes {loadedYearlyData.length} de 12 meses cargados.
                    {missingMonths.length > 0 && <>Faltan: <em>{missingMonths.join(', ')}</em>. </>}
                    Sube los meses restantes para completar el gráfico anual, o genéralo con los datos actuales.
                  </p>
                </div>
                <div className="yearly-prompt-actions">
                  <button className="prompt-btn prompt-btn--accept" onClick={() => { setShowYearlyChart(true); setShowYearlyPrompt(false); }}>
                    Generar con datos actuales
                  </button>
                  <button className="prompt-btn prompt-btn--dismiss" onClick={() => { setShowYearlyPrompt(false); }}>
                    Ahora no
                  </button>
                </div>
              </div>
            )}

            {/* KPI Summary Cards */}
            <div className="kpi-row">
              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--green">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" /></svg>
                </div>
                <div className="kpi-body">
                  <span className="kpi-value">{totalCurrent}</span>
                  <span className="kpi-label">Total Casos ({currentMonth})</span>
                </div>
                {prevMonthData.length > 0 && (
                  <span className={`kpi-badge ${totalCurrent - totalPrev >= 0 ? 'badge--up' : 'badge--down'}`}>
                    {totalCurrent - totalPrev >= 0 ? '▲' : '▼'} {Math.abs(totalCurrent - totalPrev)}
                  </span>
                )}
              </div>

              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--red">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
                </div>
                <div className="kpi-body">
                  <span className="kpi-value">{totalInc}</span>
                  <span className="kpi-label">Incidentes</span>
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--blue">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
                </div>
                <div className="kpi-body">
                  <span className="kpi-value">{totalReq}</span>
                  <span className="kpi-label">Solicitudes de Servicio</span>
                </div>
              </div>

              <div className="kpi-card">
                <div className="kpi-icon kpi-icon--green">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87" /><path d="M16 3.13a4 4 0 010 7.75" /></svg>
                </div>
                <div className="kpi-body">
                  <span className="kpi-value">{tecStats.length}</span>
                  <span className="kpi-label">Técnicos Activos</span>
                </div>
              </div>
            </div>

            {/* ═══ YEARLY OVERVIEW CHART (Bar + Lines) — only when user accepts ═══ */}
            {showYearlyChart && loadedYearlyData.length >= 1 && (
              <div className="yearly-chart-section">
                <ChartCard
                  id="chart_indicadores_anuales"
                  title="INDICADORES DE MESA DE AYUDA"
                  subtitle={`Resumen Anual — ${loadedYearlyData.length} mes(es) cargados`}
                  height="480px"
                  options={{
                    tooltip: {
                      trigger: 'axis',
                      backgroundColor: 'rgba(255,255,255,0.97)',
                      borderColor: '#e0e0e0',
                      textStyle: { color: '#333', fontSize: 12 },
                      axisPointer: { type: 'shadow' }
                    },
                    legend: {
                      data: ['Total', 'Solicitudes', 'Incidentes'],
                      bottom: 0,
                      textStyle: { color: '#555', fontSize: 12 },
                      icon: 'roundRect',
                      itemGap: 30
                    },
                    grid: {
                      left: '3%',
                      right: '4%',
                      bottom: '15%',
                      top: '8%',
                      containLabel: true
                    },
                    xAxis: {
                      type: 'category',
                      data: MONTH_NAMES.map(m => MONTH_SHORT[m]),
                      axisLabel: { fontSize: 12, color: '#555', fontWeight: 'bold' },
                      axisLine: { lineStyle: { color: '#ddd' } },
                      axisTick: { show: false }
                    },
                    yAxis: {
                      type: 'value',
                      axisLine: { show: false },
                      axisTick: { show: false },
                      splitLine: { lineStyle: { color: '#f0f0f0' } },
                      axisLabel: { color: '#888' }
                    },
                    series: [
                      {
                        name: 'Total',
                        type: 'bar',
                        barWidth: '40%',
                        data: yearlyData.map(d => d.loaded ? d.total : null),
                        itemStyle: {
                          color: {
                            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                            colorStops: [
                              { offset: 0, color: '#33C473' },
                              { offset: 1, color: '#00B050' }
                            ]
                          },
                          borderRadius: [4, 4, 0, 0]
                        },
                        label: {
                          show: true,
                          position: 'top',
                          fontSize: 12,
                          fontWeight: 'bold',
                          color: '#00B050'
                        }
                      },
                      {
                        name: 'Solicitudes',
                        type: 'line',
                        data: yearlyData.map(d => d.loaded ? d.solicitudes : null),
                        connectNulls: false,
                        smooth: true,
                        symbol: 'circle',
                        symbolSize: 8,
                        lineStyle: { width: 2.5, color: '#00B050' },
                        itemStyle: { color: '#00B050', borderColor: '#fff', borderWidth: 2 },
                      },
                      {
                        name: 'Incidentes',
                        type: 'line',
                        data: yearlyData.map(d => d.loaded ? d.incidentes : null),
                        connectNulls: false,
                        smooth: true,
                        symbol: 'circle',
                        symbolSize: 8,
                        lineStyle: { width: 2.5, color: '#0070C0' },
                        itemStyle: { color: '#0070C0', borderColor: '#fff', borderWidth: 2 },
                      }
                    ]
                  }}
                />

                {/* Data table below chart */}
                <div className="table-card yearly-data-table" id="table_indicadores_anuales">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: '120px' }}></th>
                        {MONTH_NAMES.map(m => (
                          <th key={m} className={yearlyData.find(d => d.month === m)?.loaded ? '' : 'col-empty'}>
                            {MONTH_SHORT[m]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="row-total">
                        <td><span className="legend-dot legend-dot--bar"></span> Total</td>
                        {yearlyData.map(d => (
                          <td key={d.month} className={d.loaded ? '' : 'col-empty'}>{d.loaded ? d.total : '—'}</td>
                        ))}
                      </tr>
                      <tr>
                        <td><span className="legend-dot legend-dot--green"></span> Solicitudes</td>
                        {yearlyData.map(d => (
                          <td key={d.month} className={d.loaded ? '' : 'col-empty'}>{d.loaded ? d.solicitudes : '—'}</td>
                        ))}
                      </tr>
                      <tr>
                        <td><span className="legend-dot legend-dot--blue"></span> Incidentes</td>
                        {yearlyData.map(d => (
                          <td key={d.month} className={d.loaded ? '' : 'col-empty'}>{d.loaded ? d.incidentes : '—'}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Yearly SLA chart — Atención + Solución by month */}
                <ChartCard
                  id="chart_sla_anual"
                  title="INDICADORES DE MESA DE AYUDA — Cumplimiento SLA"
                  subtitle="% de Atención y Solución a tiempo por mes"
                  height="420px"
                  options={{
                    tooltip: {
                      trigger: 'axis',
                      backgroundColor: 'rgba(255,255,255,0.97)',
                      borderColor: '#e0e0e0',
                      textStyle: { color: '#333', fontSize: 12 },
                      formatter: (params: any) => {
                        const name = params[0]?.name || '';
                        let html = `<strong>${name}</strong><br/>`;
                        params.forEach((p: any) => {
                          const val = (p.value !== null && p.value !== undefined) ? `${p.value}%` : 'N/A';
                          html += `${p.marker} ${p.seriesName}: <strong>${val}</strong><br/>`;
                        });
                        return html;
                      }
                    },
                    legend: {
                      data: ['Atención', 'Solución'],
                      bottom: 0,
                      textStyle: { color: '#555', fontSize: 12 },
                      icon: 'roundRect',
                      itemGap: 30
                    },
                    grid: {
                      left: '3%',
                      right: '4%',
                      bottom: '14%',
                      top: '8%',
                      containLabel: true
                    },
                    xAxis: {
                      type: 'category',
                      data: MONTH_NAMES.map(m => MONTH_SHORT[m]),
                      axisLabel: { fontSize: 12, color: '#555', fontWeight: 'bold' },
                      axisLine: { lineStyle: { color: '#ddd' } },
                      axisTick: { show: false }
                    },
                    yAxis: {
                      type: 'value',
                      min: 50, max: 100,
                      axisLine: { show: false },
                      axisTick: { show: false },
                      splitLine: { lineStyle: { color: '#f0f0f0' } },
                      axisLabel: { formatter: '{value}%', color: '#888' }
                    },
                    series: [
                      {
                        name: 'Atención',
                        type: 'bar',
                        barGap: '5%',
                        data: yearlySLAData.map(d => d.loaded ? d.ateRate : null),
                        itemStyle: { color: '#0070C0', borderRadius: [3, 3, 0, 0] },
                        label: {
                          show: true,
                          position: 'top',
                          fontSize: 10,
                          color: '#0070C0',
                          formatter: '{c}%'
                        }
                      },
                      {
                        name: 'Solución',
                        type: 'bar',
                        data: yearlySLAData.map(d => d.loaded ? d.solRate : null),
                        itemStyle: {
                          color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#47B078' }, { offset: 1, color: '#2E9960' }] },
                          borderRadius: [3, 3, 0, 0]
                        },
                        label: {
                          show: true,
                          position: 'top',
                          fontSize: 10,
                          color: '#2E9960',
                          formatter: '{c}%'
                        }
                      }
                    ]
                  }}
                />
              </div>
            )}

            {/* Charts Grid */}
            <div className="dashboard-grid">

              {/* 1. Casos Área de Sistemas — Vertical Bars */}
              <ChartCard
                id="chart_casos_sistemas"
                title="Casos Área de Sistemas"
                subtitle={`${currentMonth} — Total: ${totalCurrent}`}
                options={{
                  tooltip: { trigger: 'axis', backgroundColor: 'rgba(255,255,255,0.95)', borderColor: '#e0e0e0', textStyle: { color: '#333' } },
                  grid: { left: '3%', right: '4%', bottom: '12%', top: '10%', containLabel: true },
                  xAxis: {
                    type: 'category',
                    data: appStats.map(s => s[0]),
                    axisLabel: { rotate: 40, fontSize: 10, color: '#555', interval: 0 },
                    axisLine: { lineStyle: { color: '#ddd' } },
                    axisTick: { show: false }
                  },
                  yAxis: {
                    type: 'value',
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { color: '#f0f0f0' } },
                    axisLabel: { color: '#888' }
                  },
                  series: [{
                    name: 'Casos',
                    data: appStats.map(s => s[1]),
                    type: 'bar',
                    barWidth: '55%',
                    itemStyle: {
                      color: {
                        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                        colorStops: [
                          { offset: 0, color: '#00C95A' },
                          { offset: 1, color: '#00B050' }
                        ]
                      },
                      borderRadius: [4, 4, 0, 0]
                    },
                    label: { show: true, position: 'top', fontSize: 11, fontWeight: 'bold', color: '#00B050' }
                  }]
                }}
              />

              {/* 2. TOP 10 Servicios — Pie Chart */}
              <ChartCard
                id="chart_top10_servicios"
                title="TOP 10 Servicios"
                subtitle={`Distribución de Subcategorías — ${currentMonth}`}
                options={{
                  tooltip: {
                    trigger: 'item',
                    formatter: '{b}: {c} ({d}%)',
                    backgroundColor: 'rgba(255,255,255,0.95)',
                    borderColor: '#e0e0e0',
                    textStyle: { color: '#333' }
                  },
                  legend: { show: false },
                  series: [{
                    type: 'pie',
                    radius: ['0%', '80%'],
                    center: ['50%', '50%'],
                    avoidLabelOverlap: true,
                    itemStyle: { borderColor: '#fff', borderWidth: 2 },
                    label: {
                      show: true,
                      formatter: '{b}; {c}',
                      fontSize: 11,
                      color: '#333'
                    },
                    labelLine: { show: true, length: 15, length2: 10 },
                    color: PIE_GREENS,
                    data: top10.map(s => ({ name: s[0], value: s[1] }))
                  }]
                }}
              />

              {/* 3. Incidentes por Categoría */}
              <ChartCard
                id="chart_incidentes"
                title="Incidentes por Categoría"
                subtitle={`${currentMonth} — Total: ${totalInc}`}
                options={{
                  tooltip: { trigger: 'axis', backgroundColor: 'rgba(255,255,255,0.95)', borderColor: '#e0e0e0', textStyle: { color: '#333' } },
                  grid: { left: '3%', right: '8%', bottom: '3%', top: '8%', containLabel: true },
                  xAxis: {
                    type: 'value',
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { color: '#f0f0f0' } },
                    axisLabel: { color: '#888' }
                  },
                  yAxis: {
                    type: 'category',
                    data: incStats.map(s => s[0]).reverse(),
                    axisLabel: { fontSize: 10, color: '#555' },
                    axisLine: { lineStyle: { color: '#ddd' } },
                    axisTick: { show: false }
                  },
                  series: [{
                    name: 'Incidentes',
                    data: incStats.map(s => s[1]).reverse(),
                    type: 'bar',
                    barWidth: '60%',
                    itemStyle: {
                      color: {
                        type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
                        colorStops: [
                          { offset: 0, color: '#00B050' },
                          { offset: 1, color: '#33C473' }
                        ]
                      },
                      borderRadius: [0, 4, 4, 0]
                    },
                    label: { show: true, position: 'right', fontSize: 12, fontWeight: 'bold', color: '#333' }
                  }]
                }}
                height="350px"
              />

              {/* 4. Solicitudes por Categoría — GREEN style (not blue) */}
              <ChartCard
                id="chart_solicitudes"
                title="Solicitudes de Servicio"
                subtitle={`${currentMonth} — Total: ${totalReq}`}
                options={{
                  tooltip: { trigger: 'axis', backgroundColor: 'rgba(255,255,255,0.95)', borderColor: '#e0e0e0', textStyle: { color: '#333' } },
                  grid: { left: '3%', right: '8%', bottom: '3%', top: '8%', containLabel: true },
                  xAxis: {
                    type: 'value',
                    axisLine: { show: false },
                    axisTick: { show: false },
                    splitLine: { lineStyle: { color: '#f0f0f0' } },
                    axisLabel: { color: '#888' }
                  },
                  yAxis: {
                    type: 'category',
                    data: reqStats.map(s => s[0]).reverse(),
                    axisLabel: { fontSize: 10, color: '#555' },
                    axisLine: { lineStyle: { color: '#ddd' } },
                    axisTick: { show: false }
                  },
                  series: [{
                    name: 'Solicitudes',
                    data: reqStats.map(s => s[1]).reverse(),
                    type: 'bar',
                    barWidth: '60%',
                    itemStyle: {
                      color: {
                        type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
                        colorStops: [
                          { offset: 0, color: '#00B050' },
                          { offset: 1, color: '#47B078' }
                        ]
                      },
                      borderRadius: [0, 4, 4, 0]
                    },
                    label: { show: true, position: 'right', fontSize: 12, fontWeight: 'bold', color: '#1a5276' }
                  }]
                }}
                height="350px"
              />

              {/* 5. Solicitud de Información — 3D-Like Green Pillars */}
              {solInfoStats.length > 0 && (
                <ChartCard
                  id="chart_sol_info"
                  title="Solicitud de Información"
                  subtitle={`${currentMonth} — Total: ${totalSolInfo}`}
                  options={{
                    tooltip: { trigger: 'axis', backgroundColor: 'rgba(255,255,255,0.95)', borderColor: '#e0e0e0', textStyle: { color: '#333' } },
                    grid: { left: '3%', right: '4%', bottom: '12%', top: '10%', containLabel: true },
                    xAxis: {
                      type: 'category',
                      data: solInfoStats.map(s => s[0]),
                      axisLabel: { rotate: 40, fontSize: 10, color: '#555', interval: 0, formatter: (val: string) => val.length > 20 ? val.substring(0, 17) + '...' : val },
                      axisLine: { lineStyle: { color: '#ddd' } },
                      axisTick: { show: false }
                    },
                    yAxis: {
                      type: 'value',
                      axisLine: { show: false },
                      axisTick: { show: false },
                      splitLine: { lineStyle: { color: '#f0f0f0' } },
                      axisLabel: { color: '#888' }
                    },
                    series: [{
                      name: 'Solicitud de Información',
                      data: solInfoStats.map(s => s[1]),
                      type: 'bar',
                      barWidth: '40%',
                      itemStyle: {
                        color: {
                          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
                          colorStops: [
                            { offset: 0, color: '#27AE60' },
                            { offset: 1, color: '#16A085' }
                          ]
                        },
                        shadowColor: 'rgba(0, 0, 0, 0.3)',
                        shadowBlur: 5,
                        shadowOffsetX: 2,
                        shadowOffsetY: 2,
                        borderRadius: [3, 3, 0, 0]
                      },
                      label: { show: true, position: 'top', fontSize: 12, fontWeight: 'bold', color: '#333' }
                    }]
                  }}
                  height="350px"
                />
              )}

            </div>

            {/* SLA Comparative Series section */}
            <div className="chart-card" id="chart_tiempo_solucion">
              <div className="chart-card-header">
                <h3>Tiempos de Solución</h3>
                <span className="chart-subtitle">
                  {prevMonthData.length > 0 ? `${previousMonth} vs ${currentMonth}` : currentMonth} — % solucionados a tiempo
                </span>
              </div>
              <div className="sla-chart-layout">
                <div className="sla-chart-sidebar">
                  {prevMonthData.length > 0 && (
                    <div className="sla-legend">
                      <div className="sla-legend-item"><span className="sla-dot sla-dot--blue"></span> {previousMonth}</div>
                      <div className="sla-legend-item"><span className="sla-dot sla-dot--green"></span> {currentMonth}</div>
                    </div>
                  )}
                  <div className="sla-mini-table">
                    <div className="sla-mini-title">Número de Casos</div>
                    <table>
                      <thead>
                        <tr>
                          <th>Técnico</th>
                          {prevMonthData.length > 0 && <th>{MONTH_SHORT[previousMonth]}</th>}
                          <th>{MONTH_SHORT[currentMonth]}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mergedTecNames.map(name => (
                          <tr key={name}>
                            <td>{shortTecName(name)}</td>
                            {prevMonthData.length > 0 && <td>{prevTecStats.find(s => s.tec === name)?.total || 0}</td>}
                            <td>{tecStats.find(s => s.tec === name)?.total || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="sla-chart-main">
                  <ChartCard
                    id="chart_sol_bars"
                    title=""
                    height="350px"
                    options={{
                      tooltip: {
                        trigger: 'axis',
                        backgroundColor: 'rgba(255,255,255,0.95)',
                        borderColor: '#e0e0e0',
                        textStyle: { color: '#333' },
                        formatter: (params: any) => {
                          const name = params[0]?.name || '';
                          let html = `<strong>${name}</strong><br/>`;
                          params.forEach((p: any) => { html += `${p.marker} ${p.seriesName}: <strong>${p.value}%</strong><br/>`; });
                          return html;
                        }
                      },
                      legend: prevMonthData.length > 0 ? {
                        data: [previousMonth, currentMonth],
                        bottom: 0,
                        textStyle: { color: '#555', fontSize: 11 }
                      } : undefined,
                      grid: { left: '3%', right: '4%', bottom: prevMonthData.length > 0 ? '14%' : '8%', top: '8%', containLabel: true },
                      xAxis: {
                        type: 'category',
                        data: mergedTecNames.map(n => shortTecName(n)),
                        axisLabel: { rotate: 25, fontSize: 10, color: '#555', interval: 0 },
                        axisLine: { lineStyle: { color: '#ddd' } },
                        axisTick: { show: false }
                      },
                      yAxis: {
                        type: 'value', min: 50, max: 100,
                        axisLine: { show: false },
                        axisTick: { show: false },
                        splitLine: { lineStyle: { color: '#f0f0f0' } },
                        axisLabel: { formatter: '{value}%', color: '#888' }
                      },
                      series: [
                        ...(prevMonthData.length > 0 ? [{
                          name: previousMonth,
                          data: mergedTecNames.map(n => +(prevTecStats.find(s => s.tec === n)?.solRate.toFixed(1) || 0)),
                          type: 'bar' as const,
                          barGap: '15%',
                          itemStyle: { color: '#0070C0', borderRadius: [3, 3, 0, 0] },
                          label: { show: true, position: 'top' as const, fontSize: 10, color: '#0070C0', formatter: '{c}%', rotate: 90, align: 'left', verticalAlign: 'middle', distance: 1 }
                        }] : []),
                        {
                          name: currentMonth,
                          data: mergedTecNames.map(n => +(tecStats.find(s => s.tec === n)?.solRate.toFixed(1) || 0)),
                          type: 'bar' as const,
                          itemStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#00C95A' }, { offset: 1, color: '#00B050' }] },
                            borderRadius: [3, 3, 0, 0]
                          },
                          label: { show: true, position: 'top' as const, fontSize: 10, color: '#00B050', formatter: '{c}%', rotate: 90, align: 'left', verticalAlign: 'middle', distance: 1 }
                        }
                      ]
                    }}
                  />
                </div>
              </div>
            </div>

            {/* 5b. Tiempos de Atención — Comparativo mes a mes */}
            <div className="chart-card" id="chart_tiempo_atencion">
              <div className="chart-card-header">
                <h3>Tiempos de Atención</h3>
                <span className="chart-subtitle">
                  {prevMonthData.length > 0 ? `${previousMonth} vs ${currentMonth}` : currentMonth} — % 1ª respuesta a tiempo
                </span>
              </div>
              <div className="sla-chart-layout">
                <div className="sla-chart-sidebar">
                  {prevMonthData.length > 0 && (
                    <div className="sla-legend">
                      <div className="sla-legend-item"><span className="sla-dot sla-dot--blue"></span> {previousMonth}</div>
                      <div className="sla-legend-item"><span className="sla-dot sla-dot--green"></span> {currentMonth}</div>
                    </div>
                  )}
                  <div className="sla-mini-table">
                    <div className="sla-mini-title">Número de Casos</div>
                    <table>
                      <thead>
                        <tr>
                          <th>Técnico</th>
                          {prevMonthData.length > 0 && <th>{MONTH_SHORT[previousMonth]}</th>}
                          <th>{MONTH_SHORT[currentMonth]}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {mergedTecNames.map(name => (
                          <tr key={name}>
                            <td>{shortTecName(name)}</td>
                            {prevMonthData.length > 0 && <td>{prevTecStats.find(s => s.tec === name)?.total || 0}</td>}
                            <td>{tecStats.find(s => s.tec === name)?.total || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="sla-chart-main">
                  <ChartCard
                    id="chart_ate_bars"
                    title=""
                    height="350px"
                    options={{
                      tooltip: {
                        trigger: 'axis',
                        backgroundColor: 'rgba(255,255,255,0.95)',
                        borderColor: '#e0e0e0',
                        textStyle: { color: '#333' },
                        formatter: (params: any) => {
                          const name = params[0]?.name || '';
                          let html = `<strong>${name}</strong><br/>`;
                          params.forEach((p: any) => { html += `${p.marker} ${p.seriesName}: <strong>${p.value}%</strong><br/>`; });
                          return html;
                        }
                      },
                      legend: prevMonthData.length > 0 ? {
                        data: [previousMonth, currentMonth],
                        bottom: 0,
                        textStyle: { color: '#555', fontSize: 11 }
                      } : undefined,
                      grid: { left: '3%', right: '4%', bottom: prevMonthData.length > 0 ? '14%' : '8%', top: '8%', containLabel: true },
                      xAxis: {
                        type: 'category',
                        data: mergedTecNames.map(n => shortTecName(n)),
                        axisLabel: { rotate: 25, fontSize: 10, color: '#555', interval: 0 },
                        axisLine: { lineStyle: { color: '#ddd' } },
                        axisTick: { show: false }
                      },
                      yAxis: {
                        type: 'value', min: 50, max: 100,
                        axisLine: { show: false },
                        axisTick: { show: false },
                        splitLine: { lineStyle: { color: '#f0f0f0' } },
                        axisLabel: { formatter: '{value}%', color: '#888' }
                      },
                      series: [
                        ...(prevMonthData.length > 0 ? [{
                          name: previousMonth,
                          data: mergedTecNames.map(n => +(prevTecStats.find(s => s.tec === n)?.ateRate.toFixed(1) || 0)),
                          type: 'bar' as const,
                          barGap: '15%',
                          itemStyle: { color: '#0070C0', borderRadius: [3, 3, 0, 0] },
                          label: { show: true, position: 'top' as const, fontSize: 10, color: '#0070C0', formatter: '{c}%', rotate: 90, align: 'left', verticalAlign: 'middle', distance: 1 }
                        }] : []),
                        {
                          name: currentMonth,
                          data: mergedTecNames.map(n => +(tecStats.find(s => s.tec === n)?.ateRate.toFixed(1) || 0)),
                          type: 'bar' as const,
                          itemStyle: {
                            color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: '#00C95A' }, { offset: 1, color: '#00B050' }] },
                            borderRadius: [3, 3, 0, 0]
                          },
                          label: { show: true, position: 'top' as const, fontSize: 10, color: '#00B050', formatter: '{c}%', rotate: 90, align: 'left', verticalAlign: 'middle', distance: 1 }
                        }
                      ]
                    }}
                  />
                </div>
              </div>
            </div>

            {/* 6. Estado de casos */}
            <ChartCard
              id="chart_estado_casos"
              title="Estado de los Casos"
              subtitle={`Al momento de generar el informe — ${currentMonth}`}
              options={{
                tooltip: {
                  trigger: 'item',
                  formatter: '{b}: {c} ({d}%)',
                  backgroundColor: 'rgba(255,255,255,0.95)',
                  borderColor: '#e0e0e0',
                  textStyle: { color: '#333' }
                },
                legend: {
                  orient: 'vertical',
                  right: '5%',
                  top: 'center',
                  textStyle: { fontSize: 12, color: '#333' }
                },
                series: [{
                  type: 'pie',
                  radius: ['40%', '70%'],
                  center: ['35%', '50%'],
                  avoidLabelOverlap: false,
                  itemStyle: {
                    borderRadius: 6,
                    borderColor: '#fff',
                    borderWidth: 2
                  },
                  label: {
                    show: true,
                    position: 'inside',
                    formatter: '{c}',
                    fontSize: 12,
                    fontWeight: 'bold',
                    color: '#fff'
                  },
                  color: ['#00B050', '#0070C0', '#FF8C00', '#C00000', '#888'],
                  data: estadoStats.map(s => ({ name: s[0], value: s[1] }))
                }]
              }}
            />

            {/* Tables Section */}
            <div className="tables-section">
              <h2 className="section-title">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00B050" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
                ANÁLISIS COMPARATIVO
              </h2>

              {/* Resumen de Incidencias */}
              <div className="tables-row">
                <div className="table-card" id="table_incidencias_resumen">
                  <h3>Resumen de Incidencias</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Incidencias</th>
                        <th>{previousMonth}</th>
                        <th>{currentMonth}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="row-total">
                        <td>Total Casos</td>
                        <td>{totalPrev}</td>
                        <td>{totalCurrent}</td>
                      </tr>
                      <tr>
                        <td>Solicitudes de Servicio</td>
                        <td>{prevMonthData.filter(r => r.Tipo === 'Solicitud de Servicio').length}</td>
                        <td>{totalReq}</td>
                      </tr>
                      <tr>
                        <td>Solicitudes de Información</td>
                        <td>{prevMonthData.filter(r => r.Tipo === 'Solicitud de Información').length}</td>
                        <td>{totalSolInfo}</td>
                      </tr>
                      <tr>
                        <td>Incidentes</td>
                        <td>{prevMonthData.filter(r => r.Tipo === 'Incidente').length}</td>
                        <td>{totalInc}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Estado de los casos */}
                <div className="table-card" id="table_estado_casos_tbl">
                  <h3>Estado de los Casos</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Estado</th>
                        <th>Cantidad</th>
                      </tr>
                    </thead>
                    <tbody>
                      {estadoStats.map(([estado, count]) => (
                        <tr key={estado}>
                          <td><strong>{estado}</strong></td>
                          <td>{count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Incidentes comparison */}
              {prevMonthData.length > 0 && (
                <div className="tables-row">
                  <div className="table-card" id="table_incidentes_prev">
                    <h3>Incidentes — {previousMonth}</h3>
                    <table>
                      <thead>
                        <tr>
                          <th>Incidentes</th>
                          <th>{prevMonthData.filter(r => r.Tipo === 'Incidente').length}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {prevIncStats.map(([cat, count]) => (
                          <tr key={cat}>
                            <td>{cat}</td>
                            <td>{count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="table-card" id="table_incidentes_curr">
                    <h3>Incidentes — {currentMonth}</h3>
                    <table>
                      <thead>
                        <tr>
                          <th>Incidentes</th>
                          <th>{totalInc}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {incStats.map(([cat, count]) => (
                          <tr key={cat}>
                            <td>{cat}</td>
                            <td>{count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Análisis Comparativo por Categoría */}
              {prevMonthData.length > 0 && (
                <div className="table-card table-card--full" id="table_analisis_categorias">
                  <h3>Análisis por Categoría</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Casos</th>
                        <th>{previousMonth}</th>
                        <th>{currentMonth}</th>
                        <th>Diferencia</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="row-total">
                        <td><strong>Total Casos</strong></td>
                        <td><strong>{totalPrev}</strong></td>
                        <td><strong>{totalCurrent}</strong></td>
                        <td className={totalCurrent - totalPrev >= 0 ? 'diff-pos' : 'diff-neg'}>
                          <strong>{totalCurrent - totalPrev >= 0 ? '+' : ''}{totalCurrent - totalPrev}</strong>
                        </td>
                      </tr>
                      {catComparison.map(row => (
                        <tr key={row.cat}>
                          <td>•{row.cat}</td>
                          <td>{row.prev}</td>
                          <td>{row.curr}</td>
                          <td className={row.diff >= 0 ? 'diff-pos' : 'diff-neg'}>
                            {row.diff >= 0 ? '+' : ''}{row.diff}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Casos por Técnico — with CORRECTED SLA columns */}
              <div className="table-card table-card--full" id="table_casos_tecnico">
                <h3>Casos por Técnico — Detalle SLA</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Técnico</th>
                      {prevMonthData.length > 0 && <th>{previousMonth}</th>}
                      <th>{currentMonth}</th>
                      <th>Solución a Tiempo</th>
                      <th>1ª Rpta. a Tiempo</th>
                      <th>Sol. Vencidas</th>
                      <th>Rpta. Vencidas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tecStats.map(stat => (
                      <tr key={stat.tec}>
                        <td>{stat.tec}</td>
                        {prevMonthData.length > 0 && <td>{prevMonthData.filter(r => r.Tecnico === stat.tec).length}</td>}
                        <td>{stat.total}</td>
                        <td>
                          <div className="progress-cell" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div className="progress-bar-bg" style={{ width: '80%', background: 'var(--bg-light)', borderRadius: '3px', flexShrink: 0 }}>
                              <div className="progress-bar" style={{ width: `${stat.solRate}%`, backgroundColor: PPTX_GREEN, height: '6px', borderRadius: '3px' }}></div>
                            </div>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{stat.solRate}%</span>
                          </div>
                        </td>
                        <td>
                          <div className="progress-cell" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div className="progress-bar-bg" style={{ width: '80%', background: 'var(--bg-light)', borderRadius: '3px', flexShrink: 0 }}>
                              <div className="progress-bar" style={{ width: `${stat.ateRate}%`, backgroundColor: '#47B078', height: '6px', borderRadius: '3px' }}></div>
                            </div>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{stat.ateRate}%</span>
                          </div>
                        </td>
                        <td className={stat.solOverdue > 0 ? 'diff-neg' : ''}>{stat.solOverdue}</td>
                        <td className={stat.ateOverdue > 0 ? 'diff-neg' : ''}>{stat.ateOverdue}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

export default App;
