# Document text pipeline

Phase 1 extracts canonical native PDF text only. It never invokes OCR, an LLM, a vision model, an external API, browser OCR, or a system OCR fallback. The uploaded original PDF remains immutable.

## Page contract

Every page uses the physical, one-based `pdfPage`. A printed textbook label remains a separate optional `printedPage` and is never inferred by this pipeline.

Each page artifact records `source` (`pdf_text`, `ocr`, or `none`), `status` (`pending`, `extracting`, `ready`, `suspicious`, `ocr_required`, or `failed`), `classification` (`native_ready`, `native_suspicious`, `ocr_required`, or `ocr_not_needed`), deterministic `quality` metrics and flags, the coordinate system, ordered blocks, and `updatedAt`. Native suspicious pages retain `source=pdf_text` and their canonical blocks.

`PageTextBlock` contains `id`, `documentId`, one-based `pdfPage`, `order`, `type`, `text`, optional `bbox`, `source`, and optional OCR-only `confidence`. Native blocks never fabricate confidence. Initial block types are `heading`, `paragraph`, `footnote`, `list`, `table`, and `other`.

Poppler `pdftotext -bbox-layout` coordinates are stored in PDF points (1/72 inch). The origin is the top-left of the rendered Poppler page; x increases right and y increases down. Every artifact records `pageWidth` and `pageHeight` in the same unit. Bounding boxes are `{x, y, width, height}`.

## Quality decision

The decision is deterministic and page scoped. Metrics include character count, non-whitespace count, replacement characters, printable ratio, CJK count/ratio, line count, word/text-item count, bbox count, control-character ratio, and suspicious private-use glyph ratio.

OCR hard triggers are limited to empty native text with substantive visual content, at least 15% replacement characters, printable ratio below 60%, at least 30% private-use glyphs, or extraction failure. Empty pages are checked with a 36 dpi deterministic grayscale raster-ink measurement: after excluding a 3% edge margin, pixels darker than 245 count as ink and at least 2% ink is considered substantive. Visually blank pages become `ocr_not_needed` without OCR or vision inference. The 2% boundary separates the audited book's repeated blank-page background ratio (0.7547%) from its six text-bearing divider pages (40.17%-41.39%); it is not inferred from a desired OCR count.

Short text, missing bbox, replacement ratio between 2% and 15%, printable ratio from 60% to 85%, private-use ratio from 10% to 30%, exceptionally high whitespace between CJK characters, and strongly fragmented block layout become `native_suspicious`. Layout imperfection never changes a native page's source to `none`.

## Storage and lifecycle

Page artifacts are atomically written to `storage/text/{documentId}/pages/000001.json`. Lightweight job metadata is atomically written to `storage/metadata/text/{documentId}.json`, and the internal candidate report to `storage/metadata/text/{documentId}-ocr-triage.json`. The report contains metrics, classifications, and short reasons but no textbook body text. IDs and one-based page values are validated and resolved paths must remain under their designated roots.

The file-backed `DocumentTextJob` lifecycle is `queued -> processing -> completed|failed`. There is one process-wide document worker and one page subprocess at a time. Each subprocess has a timeout and an 8 MiB output limit. Upload inspection marks the PDF `ready`, then queues extraction asynchronously; PDF readiness never waits for text readiness.

At startup, `processing` and `queued` summaries become queued resumable work. Existing current-schema `ready`, `suspicious`, and `ocr_required` page artifacts remain readable and are counted rather than regenerated. Document deletion uses the existing per-document lifecycle lock and removes page artifacts, summary, and OCR triage report before removing document metadata.

## OCR-ready and AI-ready boundaries

`DisabledOcrProvider` implements the future `OcrProvider.processPage(input): Promise<OcrPageResult>` boundary by refusing execution. Pages needing OCR remain `ocr_required`. A future OCR provider should run as an independent worker.

PDF text and future OCR output are canonical extracted text. An AI system must not mutate it. Suspected OCR problems may only become an `ocr_verification_required`-style candidate issue. `ChapterTextBundle` is a data-only contract whose blocks retain `pdfPage` and `blockId` provenance; Phase 1 adds no AI endpoint, key, SDK, prompt, Skill, or MCP.

## Known limitations

Block classification is deliberately conservative and geometric reading order comes from Poppler. Multi-column layouts, tables, headers/footers, and footnotes may be imperfect. Raster-ink triage distinguishes blank pages from pages containing visible marks, but does not understand what those marks mean; a decorative nonblank page may therefore remain an OCR candidate for human review. OCR addresses missing text, while a future layout-normalization stage must address ordering and structure.
