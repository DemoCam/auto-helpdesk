# Dashboard Automatizado de Reportes - Mesa de Ayuda

Este proyecto es una herramienta diseñada para automatizar la generación de reportes mensuales de gestión de mesa de ayuda, eliminando el procesamiento manual en Excel y facilitando la creación de presentaciones en PowerPoint.

## 🚀 Arquitectura Técnica
*   **Frontend:** React 18 + TypeScript + Vite.
*   **Gestión de Estado:** Zustand (almacena datos de múltiples meses para comparativas).
*   **Visualización:** Apache ECharts (renderiza gráficas 2D/3D dinámicas).
*   **Procesamiento:** PapaParse (parsing de CSV con detección de delimitadores).
*   **Exportación:** JSZip + html-to-image (empaquetado de gráficas en un archivo .ZIP).

## 🧠 Lógica de Captura y Procesamiento

### 1. Limpieza de Datos (Ingesta)
El sistema está diseñado para ser "agnóstico" al formato de exportación de Proactivanet. 
*   **Salto de Metadatos:** El CSV original contiene filas informativas al inicio (quién generó el reporte, fecha, etc.). El motor busca dinámicamente la fila que contiene las cabeceras (`RequestID` o `Código`) y comienza el procesamiento desde ahí.
*   **Normalización:** Mapea automáticamente nombres de columnas variables (ej: "Especialista" vs "Técnico de 2ª línea") a un modelo de datos único (`ReportRow`).

### 2. Filtrado y Categorización
*   **Segmentación por Tipo:** Se separa la data basándose en la columna `Tipo`.
*   **Lógica de "Solicitudes de Servicio":** 
    *   **Identificación:** En el reporte, las "Solicitudes de Servicio" corresponden específicamente a los registros marcados como tal en la columna `Tipo`. 
    *   **Diferenciación:** Se deben distinguir de las *Solicitudes de Información* (consultas breves) y los *Incidentes* (fallos de servicio).
    *   **Volumen de Referencia:** Basado en los datos de Diciembre 2025, las Solicitudes de Servicio representan el volumen mayoritario (164 de 201 casos), concentrándose principalmente en categorías como *Novedades Administrativas*, *Aplicaciones* e *Infraestructura*.
*   **Exclusión de "Posibles Incidentes":** A diferencia del proceso manual anterior, la app confía en la clasificación final del sistema, simplificando el flujo.

## 📊 Inventario de Gráficas y Tablas (Referencia PPTX)

Basado en el análisis del archivo `Informe de Gestión Mesa de Ayuda Dic 2025.pptx`, la app genera los siguientes elementos con sus respectivos orígenes de datos:

### A. Gráficas de Volumen y Distribución
1.  **Casos Área de Sistemas (General):**
    *   **Origen:** Columna `Categoría`.
    *   **Lógica:** Conteo total por categoría técnica.
    *   **Estilo:** Barras verticales en Verde PPTX (`#00B050`).
2.  **TOP 10 Servicios:**
    *   **Origen:** Columna `Subcategoría`.
    *   **Lógica:** Agrupación de los 10 servicios más pedidos (Vacaciones, Scripts SQL, etc.).
    *   **Estilo:** Gráfico circular (Donut) con leyenda inferior.
3.  **Incidentes por Categoría:**
    *   **Origen:** Filtro `Tipo == "Incidente"` + Columna `Categoría`.
    *   **Estilo:** Barras horizontales en Rojo (`#C00000`).
4.  **Solicitudes por Categoría:**
    *   **Origen:** Filtro `Tipo == "Petición"` + Columna `Categoría`.
    *   **Estilo:** Barras horizontales en Azul (`#0070C0`).

### B. Métricas de Rendimiento (Técnicos)
5.  **Tiempos de Solución y Atención:**
    *   **Origen:** Columnas `Técnico de 2ª línea`, `Tiempo de Atencion`, `Tiempo Solucion`.
    *   **Lógica:** Porcentaje de casos con tiempos registrados válidos por cada técnico.
    *   **Estilo:** Gráfico de barras agrupadas (Azul vs Verde).

### C. Tablas Comparativas (Resumen Ejecutivo)
6.  **Resumen de Incidencias (Comparativo):**
    *   **Origen:** Conteo cruzado de la columna `Tipo` entre los meses cargados.
    *   **Columnas:** Concepto, Mes Anterior (Nov), Mes Actual (Dic).
7.  **Casos por Técnico:**
    *   **Origen:** Conteo de casos por la columna `Especialista` / `Técnico`.
    *   **Lógica:** Compara la carga de trabajo entre el mes pasado y el actual.

## 🎨 Guía de Estilo Visual
Para asegurar la consistencia con la presentación institucional:
*   **Verde Principal:** `#00B050` (Cabeceras de tablas y gráficas de volumen).
*   **Azul Corporativo:** `#0070C0` (Solicitudes y Métricas).
*   **Rojo Alerta:** `#C00000` (Incidentes).
*   **Tablas:** Encabezados con fondo sólido verde y texto blanco en negrita.

## 🛠️ Instalación y Uso
1.  Entrar a la carpeta: `cd report-app`
2.  Instalar dependencias: `npm install`
3.  Ejecutar: `npm run dev`
4.  **Carga:** Sube el CSV de Noviembre primero (seleccionando el mes) y luego el de Diciembre.
5.  **Exportación:** Haz clic en "Descargar Todo para PPTX" para obtener el .ZIP con las imágenes listas.
