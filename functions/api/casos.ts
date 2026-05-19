// /functions/api/casos.ts
// Proxy seguro para GET /api/v3/requests de Zoho SDP
// 4 capas de seguridad: CORS, Sanitización, Token KV, Mutación de respuesta

import { getAccessToken, forceRefreshToken, validateOrigin, corsHeaders, errorResponse } from "./_shared/zoho-auth";
import type { ZohoEnv } from "./_shared/zoho-auth";

const SDP_BASE_URL = "https://sdpondemand.manageengine.com/api/v3";
const PAGE_SIZE = 100;

// Campos que necesitamos de la API
const REQUIRED_FIELDS = [
  "display_id", "created_time", "subject", "status", "technician",
  "requester", "is_service_request", "category", "subcategory",
  "item", "first_response_due_by_time", "is_first_response_overdue",
  "due_by_time", "is_overdue", "request_type",
];

interface SdpRequest {
  id?: number;
  display_id?: string;
  created_time?: { display_value?: string; value?: string };
  subject?: string;
  status?: { name?: string };
  technician?: { name?: string };
  requester?: { name?: string };
  is_service_request?: boolean;
  request_type?: { name?: string };
  category?: { name?: string };
  subcategory?: { name?: string };
  item?: { name?: string };
  is_first_response_overdue?: boolean;
  is_overdue?: boolean;
}

interface SdpListResponse {
  requests?: SdpRequest[];
  response_status?: { status_code?: number; status?: string };
  list_info?: { has_more_rows?: boolean; total_count?: number };
}

export async function onRequest(context: { request: Request; env: ZohoEnv }) {
  const { request, env } = context;

  // --- CAPA 1: CORS ---
  const corsError = validateOrigin(request, env);
  if (corsError) return corsError;

  if (request.method !== "GET") {
    return errorResponse(env, 405, "Method Not Allowed");
  }

  try {
    const url = new URL(request.url);
    const mes = parseInt(url.searchParams.get("mes") || "0", 10);
    const year = parseInt(url.searchParams.get("year") || "0", 10);

    if (mes < 1 || mes > 12 || year < 2020 || year > 2100) {
      return errorResponse(env, 400, "Parámetros inválidos: mes (1-12) y year requeridos.");
    }

    // --- CAPA 2: TOKEN KV + AUTO-SANACIÓN ---
    let accessToken = await getAccessToken(env);

    // Construir rango de fechas para el filtro (Zoho requiere epoch timestamp en milisegundos)
    const startObj = new Date(year, mes - 1, 1, 0, 0, 0);
    const endObj = new Date(year, mes, 0, 23, 59, 59, 999);
    const startDate = startObj.getTime().toString();
    const endDate = endObj.getTime().toString();

    // Paginación automática
    let allRequests: SdpRequest[] = [];
    let startIndex = 1;
    let hasMore = true;

    while (hasMore) {
      const inputData = {
        list_info: {
          start_index: startIndex,
          row_count: PAGE_SIZE,
          sort_field: "created_time",
          sort_order: "asc",
          search_criteria: {
            field: "created_time",
            condition: "between",
            values: [startDate, endDate],
          },
          fields_required: REQUIRED_FIELDS,
        },
      };

      let response = await fetchSdpRequests(accessToken, inputData);

      // --- CAPA 3: AUTO-SANACIÓN ---
      if (response.status === 401) {
        console.log("Token expirado. Regenerando...");
        accessToken = await forceRefreshToken(env);
        response = await fetchSdpRequests(accessToken, inputData);
      }

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Error SDP API (${response.status}):`, errText);
        // Incluir detalles del error en la respuesta para facilitar diagnóstico
        return new Response(JSON.stringify({ error: `SDP API error: ${response.status}`, details: errText }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders(env) },
        });
      }

      const data = (await response.json()) as SdpListResponse;
      const requests = data.requests || [];

      // DEBUG: log primer request crudo para verificar estructura de respuesta
      if (startIndex === 1 && requests.length > 0) {
        console.log("DEBUG first request raw:", JSON.stringify(requests[0]));
      }

      allRequests = allRequests.concat(requests);

      hasMore = data.list_info?.has_more_rows === true && requests.length === PAGE_SIZE;
      startIndex += PAGE_SIZE;

      // Safety: max 2000 registros para evitar loops
      if (allRequests.length >= 2000) break;
    }

    // --- CAPA 4: MUTACIÓN DE RESPUESTA ---
    const rawSample = allRequests.length > 0 ? allRequests[0] : null;
    const safeData = allRequests.map(mapToSafeDto);

    return new Response(JSON.stringify({ data: safeData, total: safeData.length, status: "success", _debug_raw: rawSample }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(env) },
    });

  } catch (error: any) {
    console.error("Internal Server Error:", error.message);
    return errorResponse(env, 500, "Internal Server Error");
  }
}

/**
 * Ejecuta la llamada real a SDP API v3.
 */
async function fetchSdpRequests(accessToken: string, inputData: object): Promise<Response> {
  const params = new URLSearchParams({
    input_data: JSON.stringify(inputData),
  });

  return fetch(`${SDP_BASE_URL}/requests?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: "application/vnd.manageengine.sdp.v3+json",
    },
  });
}

/**
 * Mapea un request crudo de Zoho a un DTO seguro para el frontend.
 * NUNCA devuelve IDs internos, URLs de infraestructura, ni tokens.
 */
function mapToSafeDto(req: SdpRequest) {
  // Determinar tipo: primero por request_type si existe, luego por is_service_request
  let tipo = "No asignado";
  if (req.request_type?.name) {
    tipo = req.request_type.name;
  } else if (req.is_service_request === true) {
    tipo = "Solicitud de Servicio";
  } else if (req.is_service_request === false) {
    tipo = "Incidente";
  }

  return {
    codigo: req.display_id || String(req.id || ""),
    fecha: req.created_time?.display_value || "",
    asunto: req.subject || "",
    estado: req.status?.name || "No asignado",
    tecnico: req.technician?.name || "No asignado",
    cliente: req.requester?.name || "No asignado",
    tipo,
    categoria: req.category?.name || "No asignado",
    subcategoria: req.subcategory?.name || "No asignado",
    articulo: req.item?.name || "No asignado",
    // SLA flags: true = vencido, false = a tiempo
    tiempoAtencion: req.is_first_response_overdue === true ? "true" : req.is_first_response_overdue === false ? "false" : "",
    tiempoSolucion: req.is_overdue === true ? "true" : req.is_overdue === false ? "false" : "",
  };
}
