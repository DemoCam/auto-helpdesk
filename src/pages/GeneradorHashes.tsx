import React, { useCallback, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { useHashStore } from '../store/useHashStore';
import { searchComunicados, listAttachments, downloadAttachment, fetchActiveComunicados, checkRequestHasTasks, checkRequestHasIps } from '../utils/apiClient';
import {
  readHashSheet, readIpSheet, generateAllCsvs, generateRulesJson,
  type HashProcessResult, type IpProcessResult
} from '../utils/hashProcessor';
import LoadingOverlay from '../components/LoadingOverlay';

interface Props {
  showNotification: (msg: string, type: 'success' | 'error' | 'info') => void;
}

const GeneradorHashes: React.FC<Props> = ({ showNotification }) => {
  const store = useHashStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<'search' | 'upload'>('search');
  const [selectedRequest, setSelectedRequest] = useState<{ id: number; displayId: string; subject: string } | null>(null);

  // Estados: loading-task / done / placed / checking-ip / falta / no-requiere / error
  type BadgeState = 'loading-task' | 'done' | 'placed' | 'checking-ip' | 'falta' | 'no-requiere' | 'error';
  const [badgeMap, setBadgeMap] = useState<Record<number, BadgeState>>({});

  // Pool de concurrencia para no disparar N peticiones simultáneas (rate-limit: 60/min).
  async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const item = items[idx++];
        await fn(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }

  // Resolución en 2 fases: primero tareas (barato), luego IPs solo para los sin tarea.
  React.useEffect(() => {
    const results = store.searchResults;
    if (results.length === 0) { setBadgeMap({}); return; }

    const initial: Record<number, BadgeState> = {};
    results.forEach(r => { initial[r.id] = 'loading-task'; });
    setBadgeMap(initial);

    const noTaskIds: number[] = [];

    // Fase 1: verificar estado de tareas (concurrencia ≤6).
    runWithConcurrency(results, 6, async (r) => {
      try {
        const { hasTasks, done } = await checkRequestHasTasks(String(r.id));
        if (done) {
          setBadgeMap(prev => ({ ...prev, [r.id]: 'done' }));
        } else if (hasTasks) {
          setBadgeMap(prev => ({ ...prev, [r.id]: 'placed' }));
        } else {
          setBadgeMap(prev => ({ ...prev, [r.id]: 'checking-ip' }));
          noTaskIds.push(r.id);
        }
      } catch {
        setBadgeMap(prev => ({ ...prev, [r.id]: 'checking-ip' }));
        noTaskIds.push(r.id);
      }
    }).then(() => {
      // Fase 2: solo para los sin tarea, verificar IPs (concurrencia ≤4, más costoso).
      if (noTaskIds.length === 0) return;
      runWithConcurrency(noTaskIds, 4, async (id) => {
        try {
          const hasIps = await checkRequestHasIps(String(id));
          setBadgeMap(prev => ({ ...prev, [id]: hasIps ? 'falta' : 'no-requiere' }));
        } catch {
          // Un fallo de red/rate-limit/auth NO significa "no requiere tarea":
          // marcamos estado de error visible para no clasificar mal el comunicado.
          setBadgeMap(prev => ({ ...prev, [id]: 'error' }));
        }
      });
    });
  }, [store.searchResults]);

  // ═══ Load Active comunicados ═══
  const handleLoadActive = useCallback(async () => {
    store.setSearchStatus('loading');
    store.setSearchResults([]);
    try {
      const resp = await fetchActiveComunicados();
      store.setSearchResults(resp.data);
      store.setSearchStatus('success');
      if (resp.data.length === 0) showNotification('No hay comunicados activos (Open / On hold)', 'info');
    } catch (err: any) {
      store.setSearchStatus('error');
      showNotification(`Error cargando activos: ${err.message}`, 'error');
    }
  }, [store, showNotification]);

  // Auto-load on mount/tab change
  React.useEffect(() => {
    if (activeTab === 'search' && store.searchResults.length === 0 && store.searchStatus === 'idle') {
      handleLoadActive();
    }
  }, [activeTab, handleLoadActive]);

  // ═══ Search comunicados ═══
  const handleSearch = useCallback(async () => {
    if (!store.searchQuery.trim()) {
      return handleLoadActive();
    }
    store.setSearchStatus('loading');
    store.setSearchResults([]);
    try {
      const resp = await searchComunicados(store.searchQuery.trim());
      store.setSearchResults(resp.data);
      store.setSearchStatus('success');
      if (resp.data.length === 0) showNotification('No se encontraron comunicados con ese criterio', 'info');
    } catch (err: any) {
      store.setSearchStatus('error');
      showNotification(`Error buscando: ${err.message}`, 'error');
    }
  }, [store, showNotification, handleLoadActive]);

  // ═══ Download from Zoho ═══
  const handleDownloadFromZoho = useCallback(async (requestId: number, subject: string) => {
    store.setProcessStatus('loading');
    try {
      const attachResp = await listAttachments(String(requestId));
      if (attachResp.data.length === 0) {
        showNotification('No se encontraron adjuntos .xlsx en este caso', 'error');
        store.setProcessStatus('idle');
        return;
      }
      const attachment = attachResp.data[0];
      const { buffer, filename } = await downloadAttachment(String(requestId), String(attachment.id));
      const finalName = attachment.name || filename || `${subject}.xlsx`;
      store.setFile(finalName, buffer);
      processExcelBuffer(buffer, finalName, subject);
    } catch (err: any) {
      store.setProcessStatus('error');
      store.setErrorMessage(err.message);
      showNotification(`Error descargando adjunto: ${err.message}`, 'error');
    }
  }, [showNotification]);

  // ═══ Local file upload ═══
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      showNotification('Solo se aceptan archivos .xlsx', 'error');
      return;
    }
    const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
    if (file.size > MAX_BYTES) {
      showNotification('El archivo supera el límite de 25 MB', 'error');
      return;
    }
    store.setProcessStatus('loading');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const buffer = ev.target?.result as ArrayBuffer;
      store.setFile(file.name, buffer);
      processExcelBuffer(buffer, file.name);
    };
    reader.readAsArrayBuffer(file);
  }, [showNotification]);

  // ═══ Core processing ═══
  const processExcelBuffer = useCallback((buffer: ArrayBuffer, filename: string, subject?: string) => {
    try {
      store.resetResults();
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const allWarnings: string[] = [];
      let hashResult: HashProcessResult | null = null;
      let ipResult: IpProcessResult | null = null;

      // Process HASH sheet
      if (store.generateHashes) {
        try {
          hashResult = readHashSheet(workbook, filename, subject);
          if (hashResult.warnings.length > 0) allWarnings.push(...hashResult.warnings);
          const csvFiles = generateAllCsvs(hashResult);
          store.setHashResults(hashResult.validRows, csvFiles);
        } catch (err: any) {
          allWarnings.push(`Hashes: ${err.message}`);
        }
      }

      // Process IP sheet
      if (store.generateIps) {
        try {
          ipResult = readIpSheet(workbook, filename, subject);
          if (ipResult.warnings.length > 0) allWarnings.push(...ipResult.warnings);
          const rulesJsonFiles = generateRulesJson(ipResult, store.ruleStatus);
          store.setIpResult(ipResult, rulesJsonFiles);
        } catch (err: any) {
          allWarnings.push(`IPs: ${err.message}`);
        }
      }

      store.setWarnings(allWarnings);

      if (!hashResult && !ipResult) {
        store.setProcessStatus('error');
        const details = allWarnings.length > 0 ? ` Detalles: ${allWarnings.join(' | ')}` : '';
        store.setErrorMessage(`No se pudieron procesar ni hashes ni IPs del archivo.${details}`);
        showNotification('Error: no se encontraron datos válidos', 'error');
      } else {
        store.setProcessStatus('success');
        const hashCount = hashResult?.validRows.length || 0;
        const ipCount = ipResult?.uniqueIps.length || 0;
        showNotification(`✓ Procesado: ${hashCount} hashes, ${ipCount} IPs únicas`, 'success');
      }
    } catch (err: any) {
      store.setProcessStatus('error');
      store.setErrorMessage(err.message);
      showNotification(`Error procesando Excel: ${err.message}`, 'error');
    }
  }, [store.generateHashes, store.generateIps, store.ruleStatus, showNotification]);

  // ═══ Downloads ═══
  const downloadFile = (content: string, filename: string, mime = 'text/csv;charset=utf-8') => {
    const blob = new Blob([content], { type: mime });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const downloadComunicado = () => {
    if (!store.fileBuffer) return;
    const blob = new Blob([store.fileBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = store.filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const downloadAllRules = async () => {
    const zip = new JSZip();
    Object.entries(store.csvFiles).forEach(([name, content]) => zip.file(name, content));
    Object.entries(store.rulesJsonFiles).forEach(([name, content]) => zip.file(name, content));
    const blob = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `reglas_sentinelone_${store.ipResult?.comunicadoNumber || 'export'}.zip`;
    link.click();
    URL.revokeObjectURL(link.href);
    showNotification('✓ ZIP de reglas descargado', 'success');
  };

  const handleReset = () => {
    store.resetAll();
    setSelectedRequest(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════

  return (
    <>
      <LoadingOverlay visible={store.processStatus === 'loading' || store.searchStatus === 'loading'} message={store.searchStatus === 'loading' ? 'Buscando comunicados...' : 'Procesando archivo...'} />

      <header className="main-header">
        <div className="header-left">
          <h1>GENERADOR DE HASHES & IPs</h1>
          <p className="header-subtitle">SentinelOne Firewall Control Rules</p>
        </div>
        <div className="header-right">
          <div className="header-logo">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#00B050" /><rect x="7" y="11" width="10" height="8" rx="1.5" stroke="#fff" strokeWidth="1.8" fill="none"/><path d="M9 11V8a3 3 0 016 0v3" stroke="#fff" strokeWidth="1.8" fill="none"/></svg>
          </div>
        </div>
      </header>

      {/* ═══ Step 1: Source Selection ═══ */}
      <div className="hash-section">
        <div className="hash-section-header">
          <span className="hash-step-badge">1</span>
          <h2>Seleccionar Comunicado</h2>
        </div>

        <div className="hash-tabs">
          <button className={`hash-tab ${activeTab === 'search' ? 'hash-tab--active' : ''}`} onClick={() => setActiveTab('search')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            Buscar en Zoho
          </button>
          <button className={`hash-tab ${activeTab === 'upload' ? 'hash-tab--active' : ''}`} onClick={() => setActiveTab('upload')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Subir archivo local
          </button>
        </div>

        {activeTab === 'search' && (
          <div className="hash-search-panel">
            <div className="hash-search-row">
              <input type="text" placeholder="Buscar un ID específico (deja vacío para recargar activos)" value={store.searchQuery} onChange={e => store.setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} className="hash-search-input" />
              <button className="btn-fetch" onClick={handleSearch} disabled={store.searchStatus === 'loading'}>
                {store.searchQuery.trim() ? 'Buscar' : 'Recargar Activos'}
              </button>
            </div>
            {store.searchResults.length > 0 && (
              <div className="hash-search-results">
                {store.searchResults.map(r => (
                  <div key={r.id} className={`hash-result-item ${selectedRequest?.id === r.id ? 'hash-result-item--selected' : ''}`} onClick={() => setSelectedRequest(r)}>
                    <span className="hash-result-id">#{r.displayId}</span>
                    <span className="hash-result-subject">{r.subject}</span>
                    {(badgeMap[r.id] === 'loading-task' || badgeMap[r.id] === 'checking-ip') && (
                      <span className="hash-tasks-badge hash-tasks-badge--loading" title={badgeMap[r.id] === 'checking-ip' ? 'Verificando IPs...' : 'Verificando tareas...'}>
                        <svg className="spinner" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"/></svg>
                      </span>
                    )}
                    {badgeMap[r.id] === 'done' && (
                      <span className="hash-tasks-badge hash-tasks-badge--done">Tarea hecha</span>
                    )}
                    {badgeMap[r.id] === 'placed' && (
                      <span className="hash-tasks-badge hash-tasks-badge--placed">Tarea colocada</span>
                    )}
                    {badgeMap[r.id] === 'falta' && (
                      <span className="hash-tasks-badge hash-tasks-badge--falta">Falta tarea</span>
                    )}
                    {badgeMap[r.id] === 'no-requiere' && (
                      <span className="hash-tasks-badge hash-tasks-badge--norequiere">No requiere tarea</span>
                    )}
                    {badgeMap[r.id] === 'error' && (
                      <span className="hash-tasks-badge hash-tasks-badge--error" title="No se pudo verificar (red/límite de tasa). Recarga para reintentar.">Error al verificar</span>
                    )}
                    {selectedRequest?.id === r.id && (
                      <button className="btn-fetch btn-fetch--sm" onClick={(e) => { e.stopPropagation(); handleDownloadFromZoho(r.id, r.subject || ''); }}>
                        Descargar y Procesar
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'upload' && (
          <div className="hash-upload-panel">
            <div className="hash-dropzone" onClick={() => fileInputRef.current?.click()}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#00B050" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <p><strong>Clic para seleccionar</strong> o arrastra un archivo .xlsx</p>
              <span className="hash-dropzone-hint">Archivo de comunicado con hojas HASH e IP</span>
            </div>
            <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={handleFileUpload} />
          </div>
        )}
      </div>

      {/* ═══ Step 2: Options ═══ */}
      {store.processStatus === 'idle' && !store.filename && (
        <div className="hash-section">
          <div className="hash-section-header">
            <span className="hash-step-badge">2</span>
            <h2>Opciones de Procesamiento</h2>
          </div>
          <div className="hash-options">
            <label className="hash-option"><input type="checkbox" checked={store.generateHashes} onChange={e => store.setGenerateHashes(e.target.checked)} /><span>Generar CSVs de Hashes (SHA1/SHA256)</span></label>
            <label className="hash-option"><input type="checkbox" checked={store.generateIps} onChange={e => store.setGenerateIps(e.target.checked)} /><span>Generar Regla de Bloqueo IP (JSON)</span></label>
            <div className="hash-option-inline">
              <label>Estado de la regla IP:</label>
              <select value={store.ruleStatus} onChange={e => store.setRuleStatus(e.target.value as 'Disabled' | 'Enabled')}>
                <option value="Disabled">Disabled (default)</option>
                <option value="Enabled">Enabled</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Step 3: Results ═══ */}
      {store.processStatus === 'success' && (
        <div className="hash-section">
          <div className="hash-section-header">
            <span className="hash-step-badge hash-step-badge--success">✓</span>
            <h2>Resultados</h2>
            <button className="btn-clear-sm" onClick={handleReset} style={{ marginLeft: 'auto' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
              Nuevo análisis
            </button>
          </div>

          {/* File info */}
          <div className="hash-file-info">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00B050" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span><strong>{store.filename}</strong></span>
          </div>

          {/* Warnings */}
          {store.warnings.length > 0 && (
            <div className="hash-warnings">
              {store.warnings.map((w, i) => (<div key={i} className="hash-warning-item">⚠ {w}</div>))}
            </div>
          )}

          {/* Stats cards */}
          <div className="hash-stats-row">
            {store.hashRows.length > 0 && (
              <div className="hash-stat-card">
                <span className="hash-stat-value">{store.hashRows.length}</span>
                <span className="hash-stat-label">Hashes válidos</span>
                <span className="hash-stat-sub">{Object.keys(store.csvFiles).length} archivos CSV</span>
              </div>
            )}
            {store.ipResult && (
              <div className="hash-stat-card">
                <span className="hash-stat-value">{store.ipResult.uniqueIps.length}</span>
                <span className="hash-stat-label">IPs únicas</span>
                <span className="hash-stat-sub">
                  {Object.keys(store.rulesJsonFiles).length} JSON · Regla: {store.ruleStatus}
                </span>
              </div>
            )}
          </div>

          {/* Hash preview */}
          {store.hashRows.length > 0 && (
            <div className="table-card" id="table_hashes_preview">
              <h3>Preview — Hashes ({store.hashRows.length})</h3>
              <div style={{ maxHeight: '300px', overflow: 'auto' }}>
                <table><thead><tr><th>#</th><th>SHA1</th><th>SHA256</th></tr></thead>
                <tbody>{store.hashRows.slice(0, 50).map((row, i) => (
                  <tr key={i}><td>{i + 1}</td><td className="hash-mono">{row.SHA1.substring(0, 20)}...</td><td className="hash-mono">{row.SHA256.substring(0, 20)}...</td></tr>
                ))}{store.hashRows.length > 50 && <tr><td colSpan={3} style={{ textAlign: 'center', color: '#999' }}>... y {store.hashRows.length - 50} más</td></tr>}</tbody></table>
              </div>
            </div>
          )}

          {/* IP preview */}
          {store.ipResult && (
            <div className="table-card" id="table_ips_preview">
              <h3>Preview — IPs Únicas ({store.ipResult.uniqueIps.length})</h3>
              <div style={{ maxHeight: '250px', overflow: 'auto' }}>
                <table><thead><tr><th>#</th><th>Dirección IP</th></tr></thead>
                <tbody>{store.ipResult.uniqueIps.map((ip, i) => (
                  <tr key={i}><td>{i + 1}</td><td className="hash-mono">{ip}</td></tr>
                ))}</tbody></table>
              </div>
            </div>
          )}

          {/* Download buttons */}
          <div className="hash-download-section">
            <h3>Descargas</h3>
            <div className="hash-download-grid">
              {Object.entries(store.csvFiles).map(([name, content]) => (
                <button key={name} className="hash-download-btn" onClick={() => downloadFile(content, name)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  {name}
                </button>
              ))}
              {Object.entries(store.rulesJsonFiles).map(([name, content]) => (
                <button key={name} className="hash-download-btn hash-download-btn--json" onClick={() => downloadFile(content, name, 'application/json')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  {name}
                </button>
              ))}
            </div>
            <div className="hash-download-actions">
              <button className="btn-fetch" onClick={downloadAllRules}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                Descargar Reglas (ZIP)
              </button>
              {store.fileBuffer && (
                <button className="btn-export-sm" onClick={downloadComunicado}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  Descargar Comunicado (.xlsx)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {store.processStatus === 'error' && (
        <div className="hash-section hash-section--error">
          <div className="hash-error-box">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#C00000" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            <div>
              <strong>Error al procesar</strong>
              <p>{store.errorMessage}</p>
            </div>
            <button className="btn-clear-sm" onClick={handleReset}>Reintentar</button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {store.processStatus === 'idle' && !store.filename && activeTab === 'search' && store.searchResults.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#00B050" strokeWidth="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          </div>
          <h2>Generador de Reglas SentinelOne</h2>
          <p>Busca un comunicado en Zoho SDP o sube un archivo .xlsx manualmente para generar los CSVs de hashes y la regla JSON de bloqueo de IPs.</p>
        </div>
      )}
    </>
  );
};

export default GeneradorHashes;
