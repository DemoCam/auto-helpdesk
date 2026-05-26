// /functions/api/adjunto.ts
// Proxy seguro para descargar adjuntos de Zoho SDP API v3
// Soporta: listar adjuntos, descargar archivo binario, verificar IPs y estado de tareas

import * as XLSX from "xlsx";
import { getAccessToken, forceRefreshToken, validateOrigin, corsHeaders, errorResponse } from "./_shared/zoho-auth";
import { applyApiGuards, isNumericId, sanitizeQuery } from "./_shared/security";
import { IP_SHEET_NAME, sheetHasIps } from "./_shared/ipDetect";
import type { ZohoEnv } from "./_shared/zoho-auth";

// Tamaño máximo de adjunto a re-transmitir (evita presión de memoria / abuso).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

const SDP_BASE_URL = "https://sdpondemand.manageengine.com/api/v3";
const COMUNICADO_REGEX = /COMUNICADO[-_ ]*(\d+)/i;

// Status de tarea que se considera "cerrada/hecha" (soporte español e inglés).
const CLOSED_STATUS_NAMES = new Set(["closed", "cerrado", "cerrada"]);

// TTLs de caché KV para ipcheck.
const IPCHECK_TTL_WITH_ATTACHMENT = 60 * 60 * 24 * 30; // 30 días (contenido inmutable)
const IPCHECK_TTL_NO_ATTACHMENT = 60 * 5;               // 5 min (aún no tienen adjunto)

/**
 * Valida que un content_url de SDP sea una ruta relativa segura.
 * Previene SSRF si la respuesta de SDP fuera manipulada.
 */
function isSafeContentUrl(url: string | undefined | null): url is string {
  if (!url || typeof url !== "string") return false;
  // Debe ser ruta relativa: empieza con "/" pero NO con "//" (protocol-relative).
  if (!url.startsWith("/") || url.startsWith("//")) return false;
  // No debe contener esquema absoluto (://), @ (user:pass@host) ni caracteres de control.
  // Nota: [://] era incorrecto — coincidía con "/" individual rechazando rutas válidas.
  if (url.includes("://")) return false;
  if (url.includes("@")) return false;
  if (/[\r\n\t ]/.test(url)) return false;
  return true;
}

function isTaskClosed(statusName: unknown): boolean {
  if (!statusName || typeof statusName !== "string") return false;
  return CLOSED_STATUS_NAMES.has(statusName.trim().toLowerCase());
}

interface SdpAttachment {
  id?: number;
  name?: string;
  content_type?: string;
  size?: number;
}

interface SdpAttachmentsResponse {
  attachments?: SdpAttachment[];
}

interface SdpRequestSummary {
  id?: number;
  display_id?: string;
  subject?: string;
}

interface SdpSearchResponse {
  requests?: SdpRequestSummary[];
}

export async function onRequest(context: { request: Request; env: ZohoEnv }) {
  const { request, env } = context;

  // --- CORS ---
  const corsError = validateOrigin(request, env);
  if (corsError) return corsError;

  if (request.method !== "GET") {
    return errorResponse(env, 405, "Method Not Allowed");
  }

  // --- Rate limiting + Cloudflare Access JWT ---
  const guardError = await applyApiGuards(request, env);
  if (guardError) return guardError;

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "search";
    let accessToken = await getAccessToken(env);

    // ═══ ACTION: Buscar comunicados ═══
    if (action === "search") {
      const query = sanitizeQuery(url.searchParams.get("q") || "");
      if (!query) {
        return errorResponse(env, 400, "Parámetro 'q' requerido para buscar comunicados.");
      }

      const inputData = {
        list_info: {
          start_index: 1,
          row_count: 50,
          sort_field: "created_time",
          sort_order: "desc",
          fields_required: ["display_id", "subject", "created_time"],
          search_criteria: {
            field: "subject",
            condition: "contains",
            value: query,
          },
        },
      };

      const params = new URLSearchParams({ input_data: JSON.stringify(inputData) });
      let response = await fetch(`${SDP_BASE_URL}/requests?${params.toString()}`, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          Accept: "application/vnd.manageengine.sdp.v3+json",
        },
      });

      if (response.status === 401) {
        accessToken = await forceRefreshToken(env);
        response = await fetch(`${SDP_BASE_URL}/requests?${params.toString()}`, {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.manageengine.sdp.v3+json",
          },
        });
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`SDP search error: ${response.status} - ${errText}`);
      }

      const data = (await response.json()) as SdpSearchResponse;
      const results = (data.requests || [])
        .filter((r) => r.subject && COMUNICADO_REGEX.test(r.subject))
        .map((r) => ({
          id: r.id,
          displayId: r.display_id,
          subject: r.subject,
        }));

      return new Response(JSON.stringify({ data: results, status: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(env) },
      });
    }
    // ═══ ACTION: Listar comunicados activos (Open / On hold) ═══
    if (action === "active") {
      const inputData = {
        list_info: {
          start_index: 1,
          row_count: 100,
          sort_field: "created_time",
          sort_order: "desc",
          fields_required: ["display_id", "subject", "created_time", "status"],
          search_criteria: {
            field: "subject",
            condition: "contains",
            value: "COMUNICADO"
          }
        },
      };

      const params = new URLSearchParams({ input_data: JSON.stringify(inputData) });
      let response = await fetch(`${SDP_BASE_URL}/requests?${params.toString()}`, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          Accept: "application/vnd.manageengine.sdp.v3+json",
        },
      });

      if (response.status === 401) {
        accessToken = await forceRefreshToken(env);
        response = await fetch(`${SDP_BASE_URL}/requests?${params.toString()}`, {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.manageengine.sdp.v3+json",
          },
        });
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`SDP active list error: ${response.status} - ${errText}`);
      }

      const data = (await response.json()) as any;
      const validStatuses = ["open", "on hold", "en espera"];
      
      const results = (data.requests || [])
        .filter((r: any) => r.subject && COMUNICADO_REGEX.test(r.subject))
        .filter((r: any) => r.subject && !r.subject.toLowerCase().includes("vulnerabilidades"))
        .filter((r: any) => r.status && r.status.name && validStatuses.includes(r.status.name.toLowerCase()))
        .map((r: any) => ({
          id: r.id,
          displayId: r.display_id,
          subject: r.subject,
        }));

      return new Response(JSON.stringify({ data: results, status: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(env) },
      });
    }
    // ═══ ACTION: Verificar tareas de un request (estado: ninguna / colocada / hecha) ═══
    if (action === "tasks") {
      const requestId = url.searchParams.get("requestId");
      if (!isNumericId(requestId)) return errorResponse(env, 400, "requestId inválido.");

      const inputData = {
        list_info: {
          row_count: 50,
          start_index: 1,
          fields_required: ["status"],
        },
      };
      const params = new URLSearchParams({ input_data: JSON.stringify(inputData) });

      let response = await fetch(`${SDP_BASE_URL}/requests/${requestId}/tasks?${params.toString()}`, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          Accept: "application/vnd.manageengine.sdp.v3+json",
        },
      });

      if (response.status === 401) {
        accessToken = await forceRefreshToken(env);
        response = await fetch(`${SDP_BASE_URL}/requests/${requestId}/tasks?${params.toString()}`, {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.manageengine.sdp.v3+json",
          },
        });
      }

      if (response.status === 404) {
        return new Response(
          JSON.stringify({ data: { hasTasks: false, done: false }, status: "success" }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
        );
      }

      if (!response.ok) throw new Error(`SDP tasks error: ${response.status}`);

      const data = (await response.json()) as any;
      const tasks: any[] = Array.isArray(data.tasks) ? data.tasks : [];
      const hasTasks = tasks.length > 0;
      // "done" solo cuando TODAS las tareas están cerradas (ningún trabajo pendiente).
      const done = hasTasks && tasks.every((t: any) => isTaskClosed(t.status?.name));

      return new Response(
        JSON.stringify({ data: { hasTasks, done }, status: "success" }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
      );
    }

    // ═══ ACTION: Listar adjuntos de un request ═══
    if (action === "list") {
      const requestId = url.searchParams.get("requestId");
      if (!isNumericId(requestId)) return errorResponse(env, 400, "requestId inválido.");

      let response = await fetch(`${SDP_BASE_URL}/requests/${requestId}/attachments`, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          Accept: "application/vnd.manageengine.sdp.v3+json",
        },
      });

      if (response.status === 401) {
        accessToken = await forceRefreshToken(env);
        response = await fetch(`${SDP_BASE_URL}/requests/${requestId}/attachments`, {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.manageengine.sdp.v3+json",
          },
        });
      }

      if (!response.ok) throw new Error(`SDP attachments error: ${response.status}`);

      const data = (await response.json()) as SdpAttachmentsResponse;
      const attachments = (data.attachments || [])
        .filter((a) => a.name && a.name.toLowerCase().endsWith(".xlsx"))
        .map((a) => ({
          id: a.id,
          name: a.name,
          size: a.size,
        }));

      return new Response(JSON.stringify({ data: attachments, status: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders(env) },
      });
    }

    // ═══ ACTION: Descargar archivo adjunto (binario) ═══
    if (action === "download") {
      const requestId = url.searchParams.get("requestId");
      const attachmentId = url.searchParams.get("attachmentId");
      if (!isNumericId(requestId) || !isNumericId(attachmentId)) {
        return errorResponse(env, 400, "requestId y attachmentId inválidos.");
      }

      // 1. OBTENER METADATOS DEL ADJUNTO PARA EXTRAER EL CONTENT_URL REAL
      let metaResponse = await fetch(
        `${SDP_BASE_URL}/requests/${requestId}/attachments/${attachmentId}`,
        {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.manageengine.sdp.v3+json",
          },
        }
      );

      if (metaResponse.status === 401) {
        accessToken = await forceRefreshToken(env);
        metaResponse = await fetch(
          `${SDP_BASE_URL}/requests/${requestId}/attachments/${attachmentId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Zoho-oauthtoken ${accessToken}`,
              Accept: "application/vnd.manageengine.sdp.v3+json",
            },
          }
        );
      }

      if (!metaResponse.ok) {
        const errText = await metaResponse.text();
        throw new Error(`SDP attachment meta error: ${metaResponse.status} - ${errText}`);
      }

      const metaData = await metaResponse.json() as any;
      const contentUrl: unknown = metaData.request_attachment?.content_url;
      const originalName: string = metaData.request_attachment?.name || "comunicado.xlsx";

      // Hardening anti-SSRF: validar que content_url es una ruta relativa segura.
      if (!isSafeContentUrl(contentUrl)) {
        throw new Error("content_url inválido o inseguro en metadatos del adjunto.");
      }

      // 2. DESCARGAR EL ARCHIVO BINARIO USANDO EL CONTENT_URL
      let downloadResponse = await fetch(`${SDP_BASE_URL}${contentUrl}`, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
      });

      if (!downloadResponse.ok) {
        const errText = await downloadResponse.text();
        throw new Error(`SDP download error: ${downloadResponse.status} - ${errText}`);
      }

      // Límite de tamaño (rechaza temprano si Content-Length lo declara).
      const declaredSize = parseInt(downloadResponse.headers.get("Content-Length") || "0", 10);
      if (declaredSize > MAX_ATTACHMENT_BYTES) {
        return errorResponse(env, 413, "Adjunto demasiado grande.");
      }

      // Re-stream el binario al frontend
      const fileBytes = await downloadResponse.arrayBuffer();
      if (fileBytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return errorResponse(env, 413, "Adjunto demasiado grande.");
      }

      // Sanitizar el filename para evitar inyección de cabeceras (CRLF / comillas).
      const safeName = originalName.replace(/[\r\n"\\]/g, "_").slice(0, 200);

      return new Response(fileBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${safeName}"`,
          ...corsHeaders(env),
        },
      });
    }

    // ═══ ACTION: Verificar si un request tiene IPs en su xlsx (con caché KV) ═══
    if (action === "ipcheck") {
      const requestId = url.searchParams.get("requestId");
      if (!isNumericId(requestId)) return errorResponse(env, 400, "requestId inválido.");

      // 1. Caché KV — evita golpear SDP en listados repetidos.
      const cacheKey = `ipcheck:${requestId}`;
      const cached = await env.KV_ZOHO.get(cacheKey);
      if (cached !== null) {
        return new Response(
          JSON.stringify({ data: { hasIps: cached === "1" }, status: "success" }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
        );
      }

      // 2. Listar adjuntos: buscar el primer .xlsx.
      let listResp = await fetch(`${SDP_BASE_URL}/requests/${requestId}/attachments`, {
        method: "GET",
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          Accept: "application/vnd.manageengine.sdp.v3+json",
        },
      });
      if (listResp.status === 401) {
        accessToken = await forceRefreshToken(env);
        listResp = await fetch(`${SDP_BASE_URL}/requests/${requestId}/attachments`, {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.manageengine.sdp.v3+json",
          },
        });
      }
      if (!listResp.ok) throw new Error(`SDP attachments error: ${listResp.status}`);

      const listData = (await listResp.json()) as any;
      const xlsxAttachment = ((listData.attachments as any[]) || []).find(
        (a: any) => typeof a.name === "string" && a.name.toLowerCase().endsWith(".xlsx")
      );

      if (!xlsxAttachment) {
        // Sin adjunto aún — caché corta para no bloquear permanentemente.
        await env.KV_ZOHO.put(cacheKey, "0", { expirationTtl: IPCHECK_TTL_NO_ATTACHMENT });
        return new Response(
          JSON.stringify({ data: { hasIps: false }, status: "success" }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
        );
      }

      // 3. Obtener metadata del adjunto para extraer content_url.
      let metaResp = await fetch(
        `${SDP_BASE_URL}/requests/${requestId}/attachments/${xlsxAttachment.id}`,
        {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/vnd.manageengine.sdp.v3+json",
          },
        }
      );
      if (metaResp.status === 401) {
        accessToken = await forceRefreshToken(env);
        metaResp = await fetch(
          `${SDP_BASE_URL}/requests/${requestId}/attachments/${xlsxAttachment.id}`,
          {
            method: "GET",
            headers: {
              Authorization: `Zoho-oauthtoken ${accessToken}`,
              Accept: "application/vnd.manageengine.sdp.v3+json",
            },
          }
        );
      }
      if (!metaResp.ok) throw new Error(`SDP attachment meta error: ${metaResp.status}`);

      const metaData = (await metaResp.json()) as any;
      const contentUrl: unknown = metaData.request_attachment?.content_url;

      // 4. Hardening anti-SSRF: validar que content_url es una ruta relativa segura.
      if (!isSafeContentUrl(contentUrl)) {
        console.error("ipcheck: content_url inválido o inseguro:", contentUrl);
        return errorResponse(env, 502, "Respuesta de adjunto no válida.");
      }

      // 5. Descargar el xlsx. Guard de tamaño anti-DoS.
      let dlResp = await fetch(`${SDP_BASE_URL}${contentUrl}`, {
        method: "GET",
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });
      if (!dlResp.ok) throw new Error(`SDP download error: ${dlResp.status}`);

      const declaredSize = parseInt(dlResp.headers.get("Content-Length") || "0", 10);
      if (declaredSize > MAX_ATTACHMENT_BYTES) return errorResponse(env, 413, "Adjunto demasiado grande.");

      const fileBytes = await dlResp.arrayBuffer();
      if (fileBytes.byteLength > MAX_ATTACHMENT_BYTES) return errorResponse(env, 413, "Adjunto demasiado grande.");

      // 6. Parsear solo la hoja IP con SheetJS. Captura zip-bomb/archivos corruptos.
      let hasIps = false;
      try {
        const wb = XLSX.read(new Uint8Array(fileBytes), { type: "array", sheets: IP_SHEET_NAME });
        const sheetName = wb.SheetNames.find(
          (n) => n.trim().toUpperCase() === IP_SHEET_NAME.toUpperCase()
        );
        if (sheetName) {
          const rawData: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
            header: 1,
            defval: null,
          });
          hasIps = sheetHasIps(rawData);
        }
      } catch {
        // Xlsx corrupto o ilegible: no cachear, devolver false conservadoramente.
        return new Response(
          JSON.stringify({ data: { hasIps: false }, status: "success" }),
          { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
        );
      }

      // 7. Cachear resultado en KV (TTL largo: contenido de adjunto es inmutable).
      // Solo se expone el booleano, nunca el contenido ni las IPs.
      await env.KV_ZOHO.put(cacheKey, hasIps ? "1" : "0", {
        expirationTtl: IPCHECK_TTL_WITH_ATTACHMENT,
      });

      return new Response(
        JSON.stringify({ data: { hasIps }, status: "success" }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders(env) } }
      );
    }

    return errorResponse(env, 400, "Acción no reconocida. Use: search, active, list, download, tasks, ipcheck.");

  } catch (error: any) {
    console.error("Adjunto proxy error:", error.message);
    return errorResponse(env, 500, "Internal Server Error");
  }
}
