import type { PdfInspectionReport } from '../models/pdfInspection'

export interface PdfInspectionService {
  inspect(filePath: string): Promise<PdfInspectionReport>
}
