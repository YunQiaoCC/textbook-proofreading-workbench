export class DisabledOcrProvider {
  async processPage() {
    throw new Error('OCR provider is disabled; page remains ocr_required')
  }
}
