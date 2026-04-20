import Papa from 'papaparse';
import type { ReportRow } from '../store/useReportStore';

// Normalize strings for header matching (remove accents, lowercase)
const normalize = (s: string): string =>
  s?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim() ?? '';

// Find column index by trying multiple possible header names
const findCol = (headers: string[], ...names: string[]): number => {
  for (const name of names) {
    const idx = headers.findIndex(h => normalize(h) === normalize(name));
    if (idx !== -1) return idx;
  }
  return -1;
};

export const parseCSV = (file: File): Promise<ReportRow[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) {
        reject('No se pudo leer el archivo.');
        return;
      }

      // Detect delimiter: check if semicolons appear more than commas in the first few lines
      const sampleLines = text.split('\n').slice(0, 10).join('\n');
      const semicolons = (sampleLines.match(/;/g) || []).length;
      const commas = (sampleLines.match(/,/g) || []).length;
      const delimiter = semicolons > commas ? ';' : ',';

      Papa.parse(text, {
        header: false,
        skipEmptyLines: true,
        delimiter,
        complete: (results) => {
          const data = results.data as string[][];

          // Find the header row that contains relevant column names
          const headerIndex = data.findIndex(row =>
            row.some(cell => {
              const n = normalize(cell);
              return n === 'requestid' || n === 'codigo' || n === 'tipo' || n === 'tipo de solicitud' || n === 'categoria';
            })
          );

          if (headerIndex === -1) {
            reject('No se encontró el encabezado de datos en el CSV. Asegúrate de que el archivo tenga columnas como "RequestID", "Tipo", "Categoría".');
            return;
          }

          const headers = data[headerIndex].map(h => h.trim());
          const rawRows = data.slice(headerIndex + 1);

          // Column indices
          const iCodigo = findCol(headers, 'RequestID', 'Código', 'Codigo');
          const iFecha = findCol(headers, 'Hora de creación', 'Hora de creacion', 'Fecha de registro', 'Fecha');
          const iTitulo = findCol(headers, 'Asunto', 'Título', 'Titulo');
          const iEstado = findCol(headers, 'Estado de solicitud', 'Estado');
          const iTecnico = findCol(headers, 'Técnico', 'Tecnico', 'Especialista', 'Técnico de 2ª línea', 'Tecnico de 2a linea');
          const iCliente = findCol(headers, 'Solicitante', 'Usuario final', 'Cliente');
          const iTipo = findCol(headers, 'Tipo de solicitud', 'Tipo');
          const iCategoria = findCol(headers, 'Categoría', 'Categoria');
          const iSubcategoria = findCol(headers, 'Subcategoría', 'Subcategoria');
          const iArticulo = findCol(headers, 'Artículo', 'Articulo');
          const iTiempoAtencion = findCol(headers, 'Tiempo de Atencion', 'Tiempo de Atención', 'Estado de primera respuesta vencido');
          const iTiempoSolucion = findCol(headers, 'Tiempo Solucion', 'Tiempo Solución', 'Estado vencido');

          const getCell = (row: string[], idx: number): string => {
            if (idx === -1 || idx >= row.length) return '';
            return (row[idx] || '').trim();
          };

          const mappedRows: ReportRow[] = rawRows
            .filter(row => row.length > 1 && row.some(cell => cell.trim() !== ''))
            .map(row => {
              const rawTipo = getCell(row, iTipo);

              return {
                Codigo: getCell(row, iCodigo),
                Fecha: getCell(row, iFecha),
                Titulo: getCell(row, iTitulo),
                Estado: getCell(row, iEstado),
                Tecnico: getCell(row, iTecnico),
                Cliente: getCell(row, iCliente),
                Tipo: rawTipo,
                TiempoAtencion: getCell(row, iTiempoAtencion),
                TiempoSolucion: getCell(row, iTiempoSolucion),
                Categoria: getCell(row, iCategoria),
                Subcategoria: getCell(row, iSubcategoria),
                Articulo: getCell(row, iArticulo),
              };
            })
            .filter(row => {
              // Filter out rows without a valid type or cancelled/no-assigned rows
              if (!row.Codigo && !row.Titulo) return false;
              if (row.Tipo.toLowerCase() === 'no asignado') return false;
              if (row.Estado.toLowerCase() === 'canceled') return false;
              return true;
            });

          resolve(mappedRows);
        },
        error: (error) => reject(`Error al parsear CSV: ${error.message}`)
      });
    };
    reader.onerror = () => reject('Error al leer el archivo.');
    reader.readAsText(file, 'UTF-8');
  });
};
