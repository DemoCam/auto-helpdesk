import { create } from 'zustand';

export interface ReportRow {
  Codigo: string;
  Fecha: string;
  Titulo: string;
  Estado: string;
  Tecnico: string;
  Cliente: string;
  Tipo: string;
  TiempoAtencion: string;
  TiempoSolucion: string;
  Categoria: string;
  Subcategoria: string;
  Articulo: string;
}

export interface MonthlyData {
  monthName: string;
  rows: ReportRow[];
}

interface ReportStore {
  months: MonthlyData[];
  currentMonth: string;
  previousMonth: string;
  addMonth: (monthName: string, rows: ReportRow[]) => void;
  removeMonth: (monthName: string) => void;
  setCurrentMonth: (monthName: string) => void;
  setPreviousMonth: (monthName: string) => void;
  clearAll: () => void;
}

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

export { MONTH_NAMES };

export const useReportStore = create<ReportStore>((set) => ({
  months: [],
  currentMonth: 'Diciembre',
  previousMonth: 'Noviembre',
  addMonth: (monthName, rows) => set((state) => ({
    months: [...state.months.filter(m => m.monthName !== monthName), { monthName, rows }]
  })),
  removeMonth: (monthName) => set((state) => ({
    months: state.months.filter(m => m.monthName !== monthName)
  })),
  setCurrentMonth: (monthName) => set({ currentMonth: monthName }),
  setPreviousMonth: (monthName) => set({ previousMonth: monthName }),
  clearAll: () => set({ months: [] }),
}));
