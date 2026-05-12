// /functions/api/_shared/zoho-auth.ts
// Módulo compartido de autenticación OAuth para Zoho SDP API v3
// Patrón: Token efímero en KV con auto-sanación

const ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com";
const TOKEN_TTL_SECONDS = 3500; // Casi 1 hora (tokens de Zoho duran 1h)

export interface ZohoEnv {
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_REFRESH_TOKEN: string;
  KV_ZOHO: KVNamespace;
  ALLOWED_ORIGIN?: string;
}

/**
 * Obtiene un Access Token válido. Primero busca en KV, si no existe lo genera.
 */
export async function getAccessToken(env: ZohoEnv): Promise<string> {
  if (!env.KV_ZOHO) {
    throw new Error("FATAL: KV_ZOHO is undefined! The KV namespace binding is missing or not configured correctly in Cloudflare Dashboard.");
  }
  let token = await env.KV_ZOHO.get("ACCESS_TOKEN");
  if (token) return token;

  token = await refreshAccessToken(env);
  if (!token) throw new Error("No se pudo obtener el access token de Zoho.");

  await env.KV_ZOHO.put("ACCESS_TOKEN", token, { expirationTtl: TOKEN_TTL_SECONDS });
  return token;
}

/**
 * Fuerza la regeneración del token (para auto-sanación ante 401).
 */
export async function forceRefreshToken(env: ZohoEnv): Promise<string> {
  const token = await refreshAccessToken(env);
  if (!token) throw new Error("No se pudo refrescar el access token de Zoho.");

  if (env.KV_ZOHO) {
    await env.KV_ZOHO.put("ACCESS_TOKEN", token, { expirationTtl: TOKEN_TTL_SECONDS });
  }
  return token;
}

/**
 * Llama a Zoho Accounts para obtener un nuevo access token vía refresh_token.
 */
async function refreshAccessToken(env: ZohoEnv): Promise<string | null> {
  const faltan = [];
  if (!env.ZOHO_CLIENT_ID) faltan.push("ZOHO_CLIENT_ID");
  if (!env.ZOHO_CLIENT_SECRET) faltan.push("ZOHO_CLIENT_SECRET");
  if (!env.ZOHO_REFRESH_TOKEN) faltan.push("ZOHO_REFRESH_TOKEN");
  
  if (faltan.length > 0) {
    const envKeys = Object.keys(env).join(", ");
    const hasOrigin = !!env.ALLOWED_ORIGIN;
    throw new Error(`FATAL: Faltan credenciales de Zoho en las variables de entorno. Faltan: ${faltan.join(", ")}. Keys en env: [${envKeys}]. Tiene ALLOWED_ORIGIN? ${hasOrigin}. Por favor, asegúrate de haber hecho un 'Retry Deployment' en Cloudflare DESPUÉS de guardar las variables.`);
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN,
  });

  const response = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (response.ok) {
    const data = (await response.json()) as { access_token?: string };
    return data.access_token || null;
  }

  console.error("Error al refrescar token de Zoho:", response.status, await response.text());
  return null;
}

/**
 * Construye las cabeceras CORS seguras.
 */
export function corsHeaders(env: ZohoEnv): Record<string, string> {
  const origin = env.ALLOWED_ORIGIN || "https://auto-helpdesk.camilovalenciaburbano2017.workers.dev";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store, max-age=0",
  };
}

/**
 * Valida el origin de la petición. Devuelve una Response de error si no es válido.
 */
export function validateOrigin(request: Request, env: ZohoEnv): Response | null {
  const allowedOrigin = env.ALLOWED_ORIGIN || "https://auto-helpdesk.camilovalenciaburbano2017.workers.dev";
  const origin = request.headers.get("Origin");

  // Pre-flight
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(env) });
  }

  // En desarrollo local o peticiones del mismo origen (donde origin es null)
  if (!origin || origin === allowedOrigin || origin.startsWith("http://localhost")) {
    return null; // Origen válido
  }

  return new Response(JSON.stringify({ error: "Unauthorized Origin: " + origin }), {
    status: 403,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

/**
 * Crea una respuesta de error segura (sin exponer detalles internos).
 */
export function errorResponse(env: ZohoEnv, status = 500, publicMsg = "Internal Server Error"): Response {
  return new Response(JSON.stringify({ error: publicMsg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}
