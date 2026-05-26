// src/store/useHashStore.ts
// Zustand store para el Generador de Hashes SentinelOne

import { create } from "zustand";
import type { HashRow, IpProcessResult } from "../utils/hashProcessor";

export type ProcessStatus = "idle" | "loading" | "success" | "error";

interface ComunicadoResult {
  id: number;
  displayId: string;
  subject: string;
}

interface HashStore {
  // Estado de búsqueda
  searchQuery: string;
  searchResults: ComunicadoResult[];
  searchStatus: ProcessStatus;

  // Archivo cargado
  filename: string;
  fileBuffer: ArrayBuffer | null;

  // Resultados de procesamiento
  hashRows: HashRow[];
  ipResult: IpProcessResult | null;
  csvFiles: Record<string, string>;
  rulesJsonFiles: Record<string, string>;
  processStatus: ProcessStatus;
  errorMessage: string;
  warnings: string[];

  // Configuración
  ruleStatus: "Disabled" | "Enabled";
  generateHashes: boolean;
  generateIps: boolean;

  // Acciones
  setSearchQuery: (q: string) => void;
  setSearchResults: (results: ComunicadoResult[]) => void;
  setSearchStatus: (status: ProcessStatus) => void;
  setFile: (filename: string, buffer: ArrayBuffer | null) => void;
  setHashResults: (rows: HashRow[], csvFiles: Record<string, string>) => void;
  setIpResult: (result: IpProcessResult | null, rulesJsonFiles: Record<string, string>) => void;
  setProcessStatus: (status: ProcessStatus) => void;
  setErrorMessage: (msg: string) => void;
  setWarnings: (warnings: string[]) => void;
  setRuleStatus: (status: "Disabled" | "Enabled") => void;
  setGenerateHashes: (v: boolean) => void;
  setGenerateIps: (v: boolean) => void;
  resetResults: () => void;
  resetAll: () => void;
}

export const useHashStore = create<HashStore>((set) => ({
  searchQuery: "",
  searchResults: [],
  searchStatus: "idle",
  filename: "",
  fileBuffer: null,
  hashRows: [],
  ipResult: null,
  csvFiles: {},
  rulesJsonFiles: {},
  processStatus: "idle",
  errorMessage: "",
  warnings: [],
  ruleStatus: "Disabled",
  generateHashes: true,
  generateIps: true,

  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (results) => set({ searchResults: results }),
  setSearchStatus: (status) => set({ searchStatus: status }),
  setFile: (filename, buffer) => set({ filename, fileBuffer: buffer }),
  setHashResults: (rows, csvFiles) => set({ hashRows: rows, csvFiles }),
  setIpResult: (result, rulesJsonFiles) => set({ ipResult: result, rulesJsonFiles }),
  setProcessStatus: (status) => set({ processStatus: status }),
  setErrorMessage: (msg) => set({ errorMessage: msg }),
  setWarnings: (warnings) => set({ warnings }),
  setRuleStatus: (status) => set({ ruleStatus: status }),
  setGenerateHashes: (v) => set({ generateHashes: v }),
  setGenerateIps: (v) => set({ generateIps: v }),
  resetResults: () =>
    set({
      hashRows: [],
      ipResult: null,
      csvFiles: {},
      rulesJsonFiles: {},
      processStatus: "idle",
      errorMessage: "",
      warnings: [],
    }),
  resetAll: () =>
    set({
      searchQuery: "",
      searchResults: [],
      searchStatus: "idle",
      filename: "",
      fileBuffer: null,
      hashRows: [],
      ipResult: null,
      csvFiles: {},
      rulesJsonFiles: {},
      processStatus: "idle",
      errorMessage: "",
      warnings: [],
    }),
}));
