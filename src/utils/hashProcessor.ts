// src/utils/hashProcessor.ts
// Adaptación fiel de generar_hashes_e_ips_sentinelone_unificado.py a TypeScript
// Usa SheetJS (xlsx) para leer el Excel en el navegador

import * as XLSX from "xlsx";

// ═══════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════

const HASH_SHEET_NAME = "HASH";
const IP_SHEET_NAME = "IP";
const HEADER_ROW_NUMBER = 4; // Fila 4 (1-indexed)
const SOURCE_VALUE = "user";
const COMUNICADO_REGEX = /COMUNICADO[-_ ]*(\d+)/i;
const IPV4_REGEX = /(?<![.\d])(?:\d{1,3}\.){3}\d{1,3}(?![.\d])/g;

// ═══════════════════════════════════════════
// TIPOS
// ═══════════════════════════════════════════

export interface HashRow {
  Description: string;
  SHA1: string;
  SHA256: string;
  Source: string;
}

export interface CsvRecord {
  OS: string;
  Description: string;
  SHA1: string;
  SHA256: string;
  Source: string;
}

export interface SentinelOneRule {
  action: string;
  application: never[];
  application_type: string;
  description: null;
  direction: string;
  local_host: never[];
  local_host_type: string;
  local_port: never[];
  local_port_type: string;
  location_ids: never[];
  location_type: string;
  name: string;
  os_types: string[];
  profile: string;
  protocol: null;
  remote_host: string[];
  remote_host_type: string;
  remote_hosts: Array<{ type: string; values: string[] }>;
  remote_port: never[];
  remote_port_type: string;
  rule_type: string;
  scope: string;
  service: null;
  status: string;
  tag_ids: never[];
  tag_names: never[];
}

export interface HashProcessResult {
  validRows: HashRow[];
  description: string;
  comunicadoNumber: string;
  warnings: string[];
}

export interface IpProcessResult {
  uniqueIps: string[];
  ruleName: string;
  comunicadoNumber: string;
  warnings: string[];
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\xa0/g, " ").trim();
}

function normalizeHeader(value: unknown): string {
  let text = normalizeText(value);
  // Remove accents
  text = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  text = text.replace(/_/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.toUpperCase();
}

export function extractComunicadoNumber(filename: string): string {
  const match = COMUNICADO_REGEX.exec(filename);
  if (match) return match[1];

  // Fallback: extraer la primera secuencia de números del nombre de archivo (ej. fecha)
  const fallbackMatch = /\d+/.exec(filename);
  if (fallbackMatch) return fallbackMatch[0];

  return "XXXX"; // Default si no hay números
}

function convertNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const text = String(value).trim().replace(",", ".");
  if (!text) return null;
  const num = parseFloat(text);
  return isNaN(num) ? null : num;
}

function findSheetByName(workbook: XLSX.WorkBook, targetName: string): string {
  for (const name of workbook.SheetNames) {
    if (name.trim().toUpperCase() === targetName.toUpperCase()) return name;
  }
  throw new Error(`No existe la hoja '${targetName}' en el Excel. Hojas disponibles: ${workbook.SheetNames.join(", ")}`);
}

// ═══════════════════════════════════════════
// HASHES
// ═══════════════════════════════════════════

/**
 * Lee la hoja HASH del workbook y extrae las filas válidas.
 */
export function readHashSheet(workbook: XLSX.WorkBook, filename: string, subject?: string): HashProcessResult {
  const description = subject || filename.replace(/\.xlsx$/i, "");
  const comunicadoNumber = extractComunicadoNumber(filename);
  const warnings: string[] = [];

  const sheetName = findSheetByName(workbook, HASH_SHEET_NAME);
  const sheet = workbook.Sheets[sheetName];
  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  if (rawData.length < HEADER_ROW_NUMBER) {
    throw new Error(`La hoja '${sheetName}' no tiene suficientes filas para los encabezados (se esperan al menos ${HEADER_ROW_NUMBER}).`);
  }

  // Headers en fila 4 (índice 3)
  const headerRow = rawData[HEADER_ROW_NUMBER - 1];
  const headers = (headerRow || []).map((h) => normalizeHeader(h));

  const headerIndex: Record<string, number> = {};
  headers.forEach((h, i) => { if (h) headerIndex[h] = i; });

  const requiredCols = ["SHA1", "SHA256", "POSITIVOS"];
  const missing = requiredCols.filter((col) => !(col in headerIndex));
  if (missing.length > 0) {
    throw new Error(`Faltan columnas requeridas en la hoja '${sheetName}': ${missing.join(", ")}`);
  }

  const validRows: HashRow[] = [];
  let missingSha1 = 0;
  let missingSha256 = 0;

  for (let i = HEADER_ROW_NUMBER; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.every((cell) => cell === null || cell === undefined || String(cell).trim() === "")) continue;

    const positivosVal = row[headerIndex["POSITIVOS"]];
    const positivos = convertNumber(positivosVal);
    if (positivos === 0) continue;

    const sha1 = normalizeText(row[headerIndex["SHA1"]]);
    const sha256 = normalizeText(row[headerIndex["SHA256"]]);

    if (!sha1) missingSha1++;
    if (!sha256) missingSha256++;

    if (!sha1 || !sha256) continue;

    validRows.push({
      Description: description,
      SHA1: sha1,
      SHA256: sha256,
      Source: SOURCE_VALUE,
    });
  }

  if (missingSha1 > 0 || missingSha256 > 0) {
    warnings.push(
      `Advertencia: ${missingSha1} filas sin SHA1, ${missingSha256} filas sin SHA256 fueron excluidas.`
    );
  }

  return { validRows, description, comunicadoNumber, warnings };
}

/**
 * Construye los registros CSV para una combinación de algoritmo y SO.
 */
export function buildCsvRecords(rows: HashRow[], algorithm: "SHA1" | "SHA256", osName: string): CsvRecord[] {
  return rows.map((row) => ({
    OS: osName,
    Description: row.Description,
    SHA1: algorithm === "SHA1" ? row.SHA1 : "",
    SHA256: algorithm === "SHA256" ? row.SHA256 : "",
    Source: row.Source,
  }));
}

/**
 * Serializa registros a formato CSV exacto (con BOM UTF-8).
 * Replica el formato del Python: OS sin comillas, resto entre comillas.
 */
export function serializeCsv(records: CsvRecord[]): string {
  const BOM = "\uFEFF";
  const header = 'OS,"Description","SHA1","SHA256","Source"';
  const lines = records.map((r) => {
    const escape = (v: string) => v.replace(/"/g, '""');
    return `${escape(r.OS)},"${escape(r.Description)}","${escape(r.SHA1)}","${escape(r.SHA256)}","${escape(r.Source)}"`;
  });
  return BOM + header + "\n" + lines.join("\n") + "\n";
}

/**
 * Genera los 6 CSV files como un objeto { filename: content }.
 */
export function generateAllCsvs(hashResult: HashProcessResult): Record<string, string> {
  const { validRows, comunicadoNumber } = hashResult;
  const combos: Array<{ alg: "SHA1" | "SHA256"; os: string }> = [
    { alg: "SHA1", os: "windows" },
    { alg: "SHA1", os: "linux" },
    { alg: "SHA1", os: "macos" },
    { alg: "SHA256", os: "windows" },
    { alg: "SHA256", os: "linux" },
    { alg: "SHA256", os: "macos" },
  ];

  const files: Record<string, string> = {};
  for (const { alg, os } of combos) {
    const records = buildCsvRecords(validRows, alg, os);
    const filename = `${alg}_${os}_${comunicadoNumber}.csv`;
    files[filename] = serializeCsv(records);
  }
  return files;
}

// ═══════════════════════════════════════════
// IPs / SENTINELONE FIREWALL CONTROL
// ═══════════════════════════════════════════

/**
 * Defanga un texto de IP ofuscada a formato normal.
 */
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

/**
 * Valida si una cadena es una IPv4 válida.
 */
export function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

/**
 * Extrae IPs válidas de un texto (puede tener IPs defangadas).
 */
export function extractIpsFromValue(value: unknown): string[] {
  const text = defangToNormal(normalizeText(value));
  if (!text) return [];

  const matches = text.match(IPV4_REGEX) || [];
  return matches.filter(isValidIpv4);
}

/**
 * Deduplicar preservando el orden original.
 */
function deduplicatePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  return result;
}

/**
 * Lee la hoja IP del workbook y extrae las IPs únicas.
 */
export function readIpSheet(workbook: XLSX.WorkBook, filename: string, subject?: string): IpProcessResult {
  const ruleName = subject || filename.replace(/\.xlsx$/i, "");
  const comunicadoNumber = extractComunicadoNumber(filename);
  const warnings: string[] = [];

  const sheetName = findSheetByName(workbook, IP_SHEET_NAME);
  const sheet = workbook.Sheets[sheetName];
  const rawData: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

  if (rawData.length < HEADER_ROW_NUMBER) {
    throw new Error(`La hoja '${sheetName}' no tiene suficientes filas.`);
  }

  const headerRow = rawData[HEADER_ROW_NUMBER - 1];
  const headers = (headerRow || []).map((h) => normalizeHeader(h));
  const headerIndex: Record<string, number> = {};
  headers.forEach((h, i) => { if (h) headerIndex[h] = i; });

  const ipColName = "DIRECCION IP";
  if (!(ipColName in headerIndex)) {
    throw new Error(`Falta la columna '${ipColName}' en la hoja '${sheetName}'. Columnas: ${Object.keys(headerIndex).join(", ")}`);
  }
  const ipIdx = headerIndex[ipColName];

  const allIps: string[] = [];

  for (let i = HEADER_ROW_NUMBER; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.every((cell) => cell === null || cell === undefined || String(cell).trim() === "")) continue;

    const value = ipIdx < row.length ? row[ipIdx] : null;
    const ips = extractIpsFromValue(value);

    if (ips.length > 0) {
      allIps.push(...ips);
    } else {
      const text = normalizeText(value);
      if (text) {
        warnings.push(`Fila ${i + 1}: valor sin IP válida: ${text}`);
      }
    }
  }

  const uniqueIps = deduplicatePreservingOrder(allIps);
  if (uniqueIps.length === 0) {
    throw new Error(`No se encontraron IPs válidas en la hoja '${sheetName}'.`);
  }

  return { uniqueIps, ruleName, comunicadoNumber, warnings };
}

/**
 * Construye la regla SentinelOne Firewall Control (formato exacto del JSON exportado).
 */
export function buildSentinelOneRule(
  ruleName: string,
  ips: string[],
  status: "Disabled" | "Enabled" = "Disabled"
): SentinelOneRule {
  return {
    action: "Block",
    application: [],
    application_type: "any",
    description: null,
    direction: "any",
    local_host: [],
    local_host_type: "any",
    local_port: [],
    local_port_type: "any",
    location_ids: [],
    location_type: "all",
    name: ruleName,
    os_types: ["linux", "osx", "windows"],
    profile: "any",
    protocol: null,
    remote_host: [ips[0]],
    remote_host_type: "addresses",
    remote_hosts: ips.map((ip) => ({ type: "addresses", values: [ip] })),
    remote_port: [],
    remote_port_type: "any",
    rule_type: "custom",
    scope: "account",
    service: null,
    status,
    tag_ids: [],
    tag_names: [],
  };
}

/**
 * Genera el JSON de reglas de bloqueo.
 */
export function generateRulesJson(ipResult: IpProcessResult, status: "Disabled" | "Enabled" = "Disabled"): string {
  const rule = buildSentinelOneRule(ipResult.ruleName, ipResult.uniqueIps, status);
  return JSON.stringify([rule], null, 2) + "\n";
}
