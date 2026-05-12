// /functions/api/adjunto.ts
// Proxy seguro para descargar adjuntos de Zoho SDP API v3
// Soporta: listar adjuntos y descargar archivo binario

import { getAccessToken, forceRefreshToken, validateOrigin, corsHeaders, errorResponse } from "./_shared/zoho-auth";
import type { ZohoEnv } from "./_shared/zoho-auth";

const SDP_BASE_URL = "https://sdpondemand.manageengine.com/api/v3";
const COMUNICADO_REGEX = /COMUNICADO[-_ ]*(\d+)/i;

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

  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "search";
    let accessToken = await getAccessToken(env);

    // ═══ ACTION: Buscar comunicados ═══
    if (action === "search") {
      const query = url.searchParams.get("q") || "";
      if (!query.trim()) {
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
            condition: "like",
            value: `%COMUNICADO%${query}%`,
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

    // ═══ ACTION: Listar adjuntos de un request ═══
    if (action === "list") {
      const requestId = url.searchParams.get("requestId");
      if (!requestId) return errorResponse(env, 400, "requestId requerido.");

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
      if (!requestId || !attachmentId) {
        return errorResponse(env, 400, "requestId y attachmentId requeridos.");
      }

      // IMPORTANTE: NO enviar Accept de SDP v3 para descarga binaria
      let response = await fetch(
        `${SDP_BASE_URL}/requests/${requestId}/attachments/${attachmentId}/download`,
        {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
        }
      );

      if (response.status === 401) {
        accessToken = await forceRefreshToken(env);
        response = await fetch(
          `${SDP_BASE_URL}/requests/${requestId}/attachments/${attachmentId}/download`,
          {
            method: "GET",
            headers: {
              Authorization: `Zoho-oauthtoken ${accessToken}`,
            },
          }
        );
      }

      if (!response.ok) throw new Error(`SDP download error: ${response.status}`);

      // Re-stream el binario al frontend
      const fileBytes = await response.arrayBuffer();
      const contentDisposition = response.headers.get("Content-Disposition") || "";
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      const filename = filenameMatch ? filenameMatch[1].replace(/['"]/g, "") : "comunicado.xlsx";

      return new Response(fileBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          ...corsHeaders(env),
        },
      });
    }

    return errorResponse(env, 400, "Acción no reconocida. Use: search, list, download.");

  } catch (error: any) {
    console.error("Adjunto proxy error:", error.message);
    return errorResponse(env, 500, "Internal Server Error", String(error.stack || error.message || error));
  }
}
