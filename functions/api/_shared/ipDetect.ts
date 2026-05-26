// functions/api/_shared/ipDetect.ts
// Módulo PURO de detección de IPs — sin dependencias de DOM ni de SheetJS.
// Importado tanto por el Worker (adjunto.ts action=ipcheck) como por el frontend (hashProcessor.ts).
// Garantiza que "tiene IPs" signifique exactamente lo mismo en el badge y en el procesamiento real.

export const IP_SHEET_NAME = "IP";
export const HEADER_ROW_NUMBER = 4; // Encabezados en fila 4 (1-indexed → índice 3)

// Regex con /g — se usa SIEMPRE vía String.match() (que resetea lastIndex), nunca con .exec() manual.
const IPV4_REGEX = /(?<![.\d])(?:\d{1,3}\.){3}\d{1,3}(?![.\d])/g;

// ═══════════════════════════════════════════
// NORMALIZACIÓN DE TEXTO
// ═══════════════════════════════════════════

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\xa0/g, " ").trim();
}

export function normalizeHeader(value: unknown): string {
  let text = normalizeText(value);
  text = text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  text = text.replace(/_/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.toUpperCase();
}

// ═══════════════════════════════════════════
// DETECCIÓN DE IPs (con defang)
// ═══════════════════════════════════════════

export function defangToNormal(text: string): string {
  let result = normalizeText(text);
  const replacements: Record<string, string> = {
    "[.]": ".",
    "(.)": ".",
    "{.}": ".",
    "[dot]": ".",
    "(dot)": ".",
    "hxxp://": "http://",
    "hxxps://": "https://",
  };
  for (const [from, to] of Object.entries(replacements)) {
    result = result.split(from).join(to);
    result = result.split(from.toUpperCase()).join(to);
  }
  return result;
}

export function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

export function extractIpsFromValue(value: unknown): string[] {
  const text = defangToNormal(normalizeText(value));
  if (!text) return [];
  const matches = text.match(IPV4_REGEX) || [];
  return matches.filter(isValidIpv4);
}

// ═══════════════════════════════════════════
// CHECK DE PRESENCIA DE IPs EN UNA HOJA
// ═══════════════════════════════════════════

/**
 * Recibe el rawData (sheet_to_json con header:1, defval:null) de la hoja "IP" y
 * devuelve true si contiene al menos una IPv4 válida. Hace corto-circuito en la
 * primera IP encontrada para minimizar trabajo en el Worker.
 */
export function sheetHasIps(rawData: unknown[][]): boolean {
  if (rawData.length < HEADER_ROW_NUMBER) return false;

  const headerRow = rawData[HEADER_ROW_NUMBER - 1];
  const headers = (headerRow || []).map((h) => normalizeHeader(h));
  const headerIndex: Record<string, number> = {};
  headers.forEach((h, i) => { if (h) headerIndex[h] = i; });

  const ipColName = "DIRECCION IP";
  if (!(ipColName in headerIndex)) return false;
  const ipIdx = headerIndex[ipColName];

  for (let i = HEADER_ROW_NUMBER; i < rawData.length; i++) {
    const row = rawData[i];
    if (
      !row ||
      row.every((cell) => cell === null || cell === undefined || String(cell).trim() === "")
    ) {
      continue;
    }
    const value = ipIdx < row.length ? row[ipIdx] : null;
    if (extractIpsFromValue(value).length > 0) return true; // Corto-circuito
  }
  return false;
}
