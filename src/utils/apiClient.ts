// src/utils/apiClient.ts
// Wrapper seguro para llamadas al proxy BFF de Cloudflare
// JAMÁS incluir URLs de Zoho aquí — solo rutas relativas /api/*

interface ApiResponse<T> {
  data: T;
  total?: number;
  status: string;
}

class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

/**
 * Fetch genérico hacia el proxy. Construye URLs relativas.
 */
async function fetchFromProxy<T>(
  endpoint: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(endpoint, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: "Error desconocido" }));
    throw new ApiError(response.status, (errorBody as any).error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Obtiene los casos de SDP para un mes y año específicos.
 */
export async function fetchCasos(mes: number, year: number): Promise<ApiResponse<any[]>> {
  return fetchFromProxy<ApiResponse<any[]>>("/api/casos", {
    mes: String(mes),
    year: String(year),
  });
}

/**
 * Busca comunicados por número o texto.
 */
export async function searchComunicados(query: string): Promise<ApiResponse<any[]>> {
  return fetchFromProxy<ApiResponse<any[]>>("/api/adjunto", {
    action: "search",
    q: query,
  });
}

/**
 * Obtiene comunicados activos (Open / On hold) automáticamente.
 */
export async function fetchActiveComunicados(): Promise<ApiResponse<any[]>> {
  return fetchFromProxy<ApiResponse<any[]>>("/api/adjunto", {
    action: "active",
  });
}

/**
 * Lista los adjuntos de un request.
 */
export async function listAttachments(requestId: string): Promise<ApiResponse<any[]>> {
  return fetchFromProxy<ApiResponse<any[]>>("/api/adjunto", {
    action: "list",
    requestId,
  });
}

/**
 * Descarga un adjunto como ArrayBuffer (binario).
 */
export async function downloadAttachment(
  requestId: string,
  attachmentId: string
): Promise<{ buffer: ArrayBuffer; filename: string }> {
  const url = new URL("/api/adjunto", window.location.origin);
  url.searchParams.set("action", "download");
  url.searchParams.set("requestId", requestId);
  url.searchParams.set("attachmentId", attachmentId);

  const response = await fetch(url.toString(), {
    method: "GET",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Error al descargar adjunto: HTTP ${response.status}`);
  }

  const disposition = response.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
  const filename = filenameMatch ? filenameMatch[1].replace(/['"]/g, "") : "comunicado.xlsx";

  const buffer = await response.arrayBuffer();
  return { buffer, filename };
}

/**
 * Verifica el estado de tareas de un request.
 * - hasTasks: si existe al menos una tarea.
 * - done: si todas las tareas están cerradas (status Closed/Cerrado).
 */
export async function checkRequestHasTasks(
  requestId: string
): Promise<{ hasTasks: boolean; done: boolean }> {
  const resp = await fetchFromProxy<ApiResponse<{ hasTasks: boolean; done: boolean }>>(
    "/api/adjunto",
    { action: "tasks", requestId }
  );
  return { hasTasks: resp.data.hasTasks, done: resp.data.done };
}

/**
 * Verifica si el xlsx de un request contiene IPs en la hoja IP.
 * El resultado es cacheado en KV por el backend (inmutable por adjunto).
 */
export async function checkRequestHasIps(requestId: string): Promise<boolean> {
  const resp = await fetchFromProxy<ApiResponse<{ hasIps: boolean }>>("/api/adjunto", {
    action: "ipcheck",
    requestId,
  });
  return resp.data.hasIps;
}

/**
 * Detecta si un request agrupa varios comunicados en un hilo de correos.
 * Devuelve los números de comunicado hallados en los correos ENTRANTES del hilo
 * (sin el número base, que el frontend ya conoce desde el asunto que muestra) y
 * cuántos correos entrantes hay. El llamador une base + threadNumbers para decidir.
 */
export async function checkRequestThread(
  requestId: string
): Promise<{ threadNumbers: string[]; inboundCount: number }> {
  const resp = await fetchFromProxy<ApiResponse<{ threadNumbers: string[]; inboundCount: number }>>(
    "/api/adjunto",
    { action: "thread", requestId }
  );
  return {
    threadNumbers: resp.data.threadNumbers || [],
    inboundCount: resp.data.inboundCount || 0,
  };
}

export { ApiError };
