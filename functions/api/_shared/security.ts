// /functions/api/_shared/security.ts
// Capa de seguridad compartida: rate limiting, validación de Cloudflare Access JWT,
// validación de input y cabeceras de seguridad para respuestas de API.

import type { ZohoEnv } from "./zoho-auth";
import { errorResponse } from "./zoho-auth";

// ═══════════════════════════════════════════
// CABECERAS DE SEGURIDAD (para respuestas de API del Worker)
// El archivo public/_headers solo cubre los assets estáticos; las respuestas
// JSON del Worker necesitan estas cabeceras explícitamente.
// ═══════════════════════════════════════════
export function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

// ═══════════════════════════════════════════
// VALIDACIÓN DE INPUT
// ═══════════════════════════════════════════

/** Valida que un valor sea un ID numérico (evita path traversal hacia la API SDP). */
export function isNumericId(value: string | null): value is string {
  return value !== null && /^\d{1,18}$/.test(value);
}

/** Limita y limpia un término de búsqueda libre antes de reenviarlo a Zoho. */
export function sanitizeQuery(q: string): string {
  return q.replace(/[\r\n\t]/g, " ").trim().slice(0, 100);
}

// ═══════════════════════════════════════════
// RATE LIMITING (ventana fija por IP, respaldado en KV)
// Nota: KV no es transaccional; esto es protección básica anti-abuso, no un
// limitador estricto. Para garantías fuertes usar Cloudflare Rate Limiting Rules.
// ═══════════════════════════════════════════
const RATE_LIMIT_MAX = 60; // peticiones por ventana
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minuto

export async function checkRateLimit(request: Request, env: ZohoEnv): Promise<Response | null> {
  if (!env.KV_ZOHO) return null; // sin KV no podemos limitar; falla abierto pero se loggea en getAccessToken
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const window = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
  const key = `rl:${ip}:${window}`;

  const current = parseInt((await env.KV_ZOHO.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_MAX) {
    return errorResponse(env, 429, "Too Many Requests");
  }
  // TTL mínimo de KV es 60s
  await env.KV_ZOHO.put(key, String(current + 1), { expirationTtl: 120 });
  return null;
}

// ═══════════════════════════════════════════
// CLOUDFLARE ACCESS — VALIDACIÓN DE JWT (Zero Trust)
// Solo se activa si ACCESS_TEAM_DOMAIN y ACCESS_AUD están configurados.
// Mientras no estén, la función no bloquea (para no romper el despliegue actual),
// pero el código queda listo para activarse al setear esas variables.
// ═══════════════════════════════════════════

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

function b64urlToBytes(s: string): Uint8Array {
  let str = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4;
  if (pad) str += "=".repeat(4 - pad);
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function getJwks(env: ZohoEnv, teamDomain: string): Promise<{ keys: Jwk[] }> {
  // Cache del JWKS en KV (1h) para no pegarle a Cloudflare en cada request.
  if (env.KV_ZOHO) {
    const cached = await env.KV_ZOHO.get("access_jwks");
    if (cached) return JSON.parse(cached) as { keys: Jwk[] };
  }
  const resp = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!resp.ok) throw new Error("No se pudo obtener el JWKS de Cloudflare Access");
  const jwks = (await resp.json()) as { keys: Jwk[] };
  if (env.KV_ZOHO) {
    await env.KV_ZOHO.put("access_jwks", JSON.stringify(jwks), { expirationTtl: 3600 });
  }
  return jwks;
}

/**
 * Verifica el JWT de Cloudflare Access. Devuelve una Response de error si la
 * validación falla, o null si pasa (o si Access no está configurado todavía).
 */
export async function verifyAccessJwt(request: Request, env: ZohoEnv): Promise<Response | null> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const expectedAud = env.ACCESS_AUD;

  // Access no configurado → no se aplica (queda listo para activarse).
  if (!teamDomain || !expectedAud) return null;

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") || getCookie(request, "CF_Authorization");
  if (!token) return errorResponse(env, 403, "Forbidden");

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return errorResponse(env, 403, "Forbidden");
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(b64urlToString(headerB64)) as { kid?: string; alg?: string };
    const payload = JSON.parse(b64urlToString(payloadB64)) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
    };

    if (header.alg !== "RS256" || !header.kid) return errorResponse(env, 403, "Forbidden");

    const jwks = await getJwks(env, teamDomain);
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) return errorResponse(env, 403, "Forbidden");

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      b64urlToBytes(sigB64),
      data
    );
    if (!valid) return errorResponse(env, 403, "Forbidden");

    // Validación de claims
    if (payload.iss !== `https://${teamDomain}`) return errorResponse(env, 403, "Forbidden");
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(expectedAud)) return errorResponse(env, 403, "Forbidden");
    if (!payload.exp || payload.exp * 1000 < Date.now()) return errorResponse(env, 403, "Forbidden");

    return null; // ✓ token válido
  } catch {
    return errorResponse(env, 403, "Forbidden");
  }
}

/**
 * Guard combinado: rate limit + Cloudflare Access JWT.
 * Devuelve la primera Response de error encontrada, o null si todo pasa.
 */
export async function applyApiGuards(request: Request, env: ZohoEnv): Promise<Response | null> {
  const rl = await checkRateLimit(request, env);
  if (rl) return rl;
  const auth = await verifyAccessJwt(request, env);
  if (auth) return auth;
  return null;
}
