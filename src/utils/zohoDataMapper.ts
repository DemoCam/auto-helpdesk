// src/utils/zohoDataMapper.ts
// Mapea la respuesta sanitizada del proxy → ReportRow[] para el store
// El proxy ya hace la limpieza pesada; aquí solo normalizamos el contrato

import type { ReportRow } from "../store/useReportStore";

interface ZohoCasoDTO {
  codigo: string;
  fecha: string;
  asunto: string;
  estado: string;
  tecnico: string;
  cliente: string;
  tipo: string;
  categoria: string;
  subcategoria: string;
  articulo: string;
  tiempoAtencion: string;
  tiempoSolucion: string;
}

/**
 * Convierte un array de DTOs del proxy en ReportRow[] compatibles con el store.
 * Esto mantiene el contrato exacto para que TODAS las gráficas existentes funcionen sin cambios.
 */
export function mapZohoResponseToReportRows(apiData: ZohoCasoDTO[]): ReportRow[] {
  return apiData
    .map((dto) => ({
      Codigo: dto.codigo || "",
      Fecha: dto.fecha || "",
      Titulo: dto.asunto || "",
      Estado: dto.estado || "No asignado",
      Tecnico: dto.tecnico || "No asignado",
      Cliente: dto.cliente || "No asignado",
      Tipo: normalizeRequestType(dto.tipo),
      TiempoAtencion: dto.tiempoAtencion || "",
      TiempoSolucion: dto.tiempoSolucion || "",
      Categoria: dto.categoria || "No asignado",
      Subcategoria: dto.subcategoria || "No asignado",
      Articulo: dto.articulo || "No asignado",
    }))
    .filter((row) => {
      if (!row.Codigo && !row.Titulo) return false;
      return true;
    });
}

/**
 * Normaliza los nombres de tipo de solicitud de SDP a los nombres
 * que espera la lógica existente de gráficas.
 */
function normalizeRequestType(tipo: string): string {
  if (!tipo) return "No asignado";

  const lower = tipo.toLowerCase().trim();

  // Mapeo de nombres posibles de SDP → nombres que usa la app
  if (lower.includes("solicitud de servicio") || lower === "service request") {
    return "Solicitud de Servicio";
  }
  if (lower.includes("incidente") || lower === "incident") {
    return "Incidente";
  }
  if (lower.includes("solicitud de información") || lower === "information request") {
    return "Solicitud de Información";
  }

  // Si es un nombre custom, devolverlo tal cual
  return tipo;
}

/**
 * Detecta el mes a partir de las fechas en los datos.
 * Formato esperado del proxy: "11 May 2026 03:14 PM" o similar.
 */
export function detectMonthFromApiData(rows: ReportRow[]): { monthIndex: number; year: number } | null {
  for (const row of rows) {
    if (!row.Fecha) continue;

    // Intentar parsear "DD Mon YYYY" o "DD-MM-YYYY" o "YYYY-MM-DD"
    const date = new Date(row.Fecha);
    if (!isNaN(date.getTime())) {
      return { monthIndex: date.getMonth(), year: date.getFullYear() };
    }

    // Fallback: buscar patrón DD-MM-YYYY o DD/MM/YYYY
    const parts = row.Fecha.split(/[-/]/);
    if (parts.length >= 3) {
      const mm = parseInt(parts[1], 10);
      const yyyy = parseInt(parts[2], 10);
      if (mm >= 1 && mm <= 12 && yyyy >= 2020) {
        return { monthIndex: mm - 1, year: yyyy };
      }
    }
  }
  return null;
}
