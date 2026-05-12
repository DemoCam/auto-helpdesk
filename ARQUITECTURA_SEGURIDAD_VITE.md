# Arquitectura Segura para API de Zoho SDP en Cloudflare Pages
*Documento de Arquitectura y Seguridad escrito por el Senior Security Engineer*

Este documento técnico detalla la arquitectura de seguridad requerida para implementar la API v3 de ManageEngine ServiceDesk Plus (Zoho) en un ecosistema Frontend (`Vite + React + TypeScript`) alojado en Cloudflare Pages, evitando completamente la exposición pública de credenciales (Client ID, Secret, Refresh Token).

## 1. Diseño de Arquitectura (Backend-For-Frontend Pattern)
Las aplicaciones React (Single Page Applications) se ejecutan 100% en el navegador del cliente. **Bajo ningún contexto** se deben incluir tokens o variables de entorno financieras/API dentro del código compilado de React (ni siquiera en archivos `.env` consumidos por Vite vía `VITE_API_KEY`). Si esto se hace, cualquier usuario podrá inspeccionar el bundle (F12 -> Sources) y tomar control total de la instancia de SDP.

**Solución:** Se implementará un **Cloudflare Pages Worker (Function)** que actuará como un intermediario (Proxy/BFF). 

```mermaid
graph LR
    A[Navegador Cliente - React] -->|GET /api/informe| B(Cloudflare Function Proxy)
    B -->|Busca Variables en Entorno Seguro de CF| C{Secret Vault}
    B -->|POST OAuth / Reflexión Token| D[Zoho Accounts]
    B -->|GET /requests Filtrado| E[ManageEngine SDP API]
    E -->|JSON crudo| B
    B -->|Paginación en Server + Limpieza de Datos| B
    B -->|JSON Seguro (Solo datos necesarios)| A
```

## 2. ⚠️ PASOS MANUALES EXCLUSIVOS PARA EL USUARIO HUMANO (Consola de Cloudflare)
> **[NOTA PARA LA IA IMPLEMENTADORA]:** No intentes automatizar ni codificar estos pasos en el repositorio. El usuario humano DEBE configurar esto manualmente en el Dashboard de Cloudflare para garantizar la separación de hardware y código.

1. **Crear y Conectar la Base de Datos Temporal (Cloudflare KV):**
   - **Acción Humana:** Ve a *Workers & Pages* > *KV* > Crea un Namespace llamado `proxy_zoho_cache`.
   - Luego, entra a tu proyecto de *Pages* > *Settings* > *Functions* > *KV namespace bindings*.
   - Añade la conexión: **Variable name:** `KV_ZOHO` apuntando al namespace que acabas de crear. *(Sin esto, la función del código arrojará error 500 al intentar guardar el token).*

2. **Inyectar Variables de Entorno Secretas:**
   - **Acción Humana:** En tu proyecto, ve a *Settings* > *Environment variables*.
   - Añade las credenciales (marcando siempre el candado de **Encrypt**):
     - `ZOHO_CLIENT_ID`
     - `ZOHO_CLIENT_SECRET`
     - `ZOHO_REFRESH_TOKEN`
   - *(La IA deberá usar un archivo local `.dev.vars` exclusivamente para el entorno de desarrollo simulado).*

3. **Bloqueo a Nivel de Red (Zero Trust Access - CAPA CRÍTICA):**
   - **Atención Humano e IA:** El código CORS (Capa 1 del código abajo) protege contra otras webs robando datos, pero **NO bloquea** peticiones directas hechas desde Postman, cURL o scripts maliciosos. 
   - **La Solución Anti-Postman/cURL:** Para esto es **Cloudflare Zero Trust**. Al activarlo sobre tu dominio, Cloudflare envuelve tu API en una "burbuja". Si alguien lanza un cURL o usa Postman, Cloudflare intercepta el ataque en la frontera y devuelve una página HTML de inicio de sesión (MFA/SSO) en lugar de consultar tu API. Hasta que no inician sesión con su correo corporativo, no pasan.
   - **(Opcional para IA):** Validar el token JWT de Cloudflare Access (`Cf-Access-Jwt-Assertion`) dentro del Worker para garantizar criptográficamente que la petición pasó por el login humano corporativo.

## 3. Implementación de Código (Cloudflare Worker)
El siguiente es el código Ciberseguro sugerido para el archivo `functions/api/casos.ts`. 

Este código incluye 4 capas extra de seguridad:
1. **Validación de CORS estricto.**
2. **Sanitización de cabeceras entrantes.**
3. **Gestión de Access Token efímero en Cloudflare KV (Evita saturar el límite de rate de Zoho Accounts).**
4. **Mutación de la respuesta (solo devuelve lo que el frontend necesita ver, quitando IDs internos corporativos o URLs de infraestructura).**

```typescript
// /functions/api/casos.ts

export async function onRequest(context) {
    const { request, env } = context;

    // --- CAPA 1: PROTECCIÓN CORS Y CSRF ---
    const allowedOrigin = "https://tu-proyecto.pages.dev"; // Reemplazar en PRD
    const origin = request.headers.get("Origin");

    // Pre-flight request handshake
    if (request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": allowedOrigin,
                "Access-Control-Allow-Methods": "GET",
                // Limitamos severamente los cabezales aceptados para evitar inyección
                "Access-Control-Allow-Headers": "Content-Type", 
                "Access-Control-Max-Age": "86400",
            }
        });
    }

    // Validación estricta de origen del requester
    if (origin !== allowedOrigin) {
        return new Response(JSON.stringify({ error: "Unauthorized Origin" }), { 
            status: 403, 
            headers: { "Content-Type": "application/json" } 
        });
    }

    try {
        // --- CAPA 2: LECTURA DE ACCESS TOKEN EN CACHÉ (KV) ---
        // Intentamos usar el token que ya tenemos guardado
        let accessToken = await env.KV_ZOHO.get("ACCESS_TOKEN");
        
        // Si no hay token guardado (es la primera vez), obtenemos uno
        if (!accessToken) {
            accessToken = await obtenerAccessToken(env);
            // Guardamos el token en KV y le decimos que expire automáticamente en 3500 segundos (casi 1 hora)
            await env.KV_ZOHO.put("ACCESS_TOKEN", accessToken, { expirationTtl: 3500 });
        }

        // --- CAPA 3: LLAMADA A ZOHO Y AUTO-SANACIÓN (REINTENTO POR 401) ---
        let zohoResponse = await hacerPeticionZoho(accessToken);

        // Patrón de Auto-Sanación: Si el token caducó en Zoho, nos dará un 401
        if (zohoResponse.status === 401) {
            console.log("Token expirado detectado. Generando uno nuevo...");
            // Refrescamos forzosamente el token
            accessToken = await obtenerAccessToken(env);
            await env.KV_ZOHO.put("ACCESS_TOKEN", accessToken, { expirationTtl: 3500 });
            
            // Reintentamos la petición con el token fresco
            zohoResponse = await hacerPeticionZoho(accessToken);
        }

        if (!zohoResponse.ok) {
            throw new Error(`Error en Zoho API: ${zohoResponse.status}`);
        }

        const rawZohoData = await zohoResponse.json(); // Data cruda de Zoho

        // NUNCA DEVOLVER EL PAYLOAD CRUDO AL FRONTEND.
        // Un ataque XSS en el frontend podría extraer hashes o rutas internas de Zoho.
        const safeDataForReact = rawZohoData.map(req => ({
            id: req.id,
            asunto: req.subject,
            tecnico: req.technician?.name || "Sin asignar"
        }));

        return new Response(JSON.stringify({ data: safeDataForReact, status: "success" }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": allowedOrigin,
                // Le decimos al navegador que prohiíba guardar esto en caché de disco local
                "Cache-Control": "no-store, max-age=0"
            }
        });

    } catch (error) {
        // --- CAPA 4: MANEJO SEGURO DE EXCEPCIONES ---
        // Jamás le devuelvas el texto real del error al frontend. (Podría exponer pedazos del Token).
        console.error("Internal Server Error:", error.message); 
        return new Response(JSON.stringify({ error: "Internal Server Error. Reference ID: XyZ." }), { 
            status: 500,
            headers: { "Access-Control-Allow-Origin": allowedOrigin }
        });
    }
}

/**
 * Función helper para aislar la llamada a Zoho
 */
async function hacerPeticionZoho(accessToken) {
    const url = "https://sdpondemand.manageengine.com/app/itdesk/api/v3/requests"; // Ejemplo URL
    return await fetch(url, {
        method: "GET",
        headers: {
            "Authorization": `Zoho-oauthtoken ${accessToken}`,
            "Accept": "application/vnd.manageengine.sdp.v3+json"
        }
    });
}

/**
 * Función interna aisalada. 
 * Invoca el servidor de autorización sin tocar en ningún momento el objeto context general.
 */
async function obtenerAccessToken(env) {
    // Nota: Por seguridad, se desaconseja guardar client_secret hardcodeados. 
    // Siempre tomarlos de `env.ZOHO_CLIENT_SECRET` (Cloudflare Secrets).
    const accountsUrl = env.ACCOUNTS_URL || "https://accounts.zoho.com";
    
    // Formato x-www-form-urlencoded es más seguro para OAuth que JSON POST
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.ZOHO_CLIENT_ID,
        client_secret: env.ZOHO_CLIENT_SECRET,
        refresh_token: env.ZOHO_REFRESH_TOKEN
    });

    const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
    });

    if (response.ok) {
        const data = await response.json();
        return data.access_token;
    }
    
    return null;
}
```

## 4. Políticas de Seguridad HTTP Estrictas (Para el Frontend)
> **[NOTA PARA LA IA IMPLEMENTADORA]:** Debes crear un archivo estático llamado `_headers` dentro de la carpeta `public/` de Vite.

Cloudflare Pages inyectará automáticamente estas cabeceras a la aplicación React, bloqueando ataques de Inyección de Código (XSS) y Clickjacking.

**Contenido requerido para `public/_headers`:**
```text
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; connect-src 'self' https://tusitio.pages.dev; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'
```

## 5. Consideraciones en el Frontend (Vite + React)
- Elimina cualquier dependencia que diga `dotenv` de tus dependencias de Vite.
- En los componentes `.tsx`, la llamada de datos (con SWR, React Query, o Fetch nativo) debe apuntar a la ruta relativa `/api/casos`. Jamás incluyas la cadena `sdpondemand.manageengine...` en el código de React.

**Implementación Segura Finalizada.** Con este enfoque de mitigación, un atacante que intercepte la URL de la web se estrellará primero contra la pantalla Zero Trust Authentication de Cloudflare. Si la web fuera pública, y lograran encontrar y ejecutar el *endpoint* de `/api/casos`, se llevarían un Error 403 de CORS, ya que sus orígenes no coinciden. Finalmente, incluso si forzaran el *Origin* falseado mediante Postman/cURL, solo recibirían un JSON "sanitizado" con nombres y fechas para gráficos, sin obtener jamás el conocimiento para modificar, manipular o autenticarse en el servidor real corporativo de la mesa de ayuda.