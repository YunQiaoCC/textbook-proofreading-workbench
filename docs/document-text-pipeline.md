# Document text pipeline

Phase 1 extracts canonical native PDF text only. It never invokes OCR, an LLM, a vision model, an external API, browser OCR, or a system OCR fallback. The uploaded original PDF remains immutable.

## Page contract

Every page uses the physical, one-based `pdfPage`. A printed textbook label remains a separate optional `printedPage` and is never inferred by this pipeline.

Each page artifact records `source` (`pdf_text`, `ocr`, or `none`), `status` (`pending`, `extracting`, `ready`, `ocr_required`, or `failed`), `charCount`, deterministic `quality` metrics and flags, the coordinate system, ordered blocks, and `updatedAt`. Phase 1 only writes `pdf_text` or `none`.

`PageTextBlock` contains `id`, `documentId`, one-based `pdfPage`, `order`, `type`, `text`, optional `bbox`, `source`, and optional OCR-only `confidence`. Native blocks never fabricate confidence. Initial block types are `heading`, `paragraph`, `footnote`, `list`, `table`, and `other`.

Poppler `pdftotext -bbox-layout` coordinates are stored in PDF points (1/72 inch). The origin is the top-left of the rendered Poppler page; x increases right and y increases down. Every artifact records `pageWidth` and `pageHeight` in the same unit. Bounding boxes are `{x, y, width, height}`.

## Quality decision

The decision is deterministic and page scoped. Metrics include character count, non-whitespace count, replacement characters, printable ratio, CJK count/ratio, line count, word/text-item count, bbox count, control-character ratio, and suspicious private-use glyph ratio.

Native text is rejected when it is empty, has fewer than 20 non-whitespace characters, has more than 2% replacement characters, has a printable ratio below 85%, has more than 10% private-use glyphs, or has meaningful text but no parsed bbox. Accepted pages receive `usable_native_text`; rejected pages keep explanatory flags such as `empty_text`, `too_little_text`, `replacement_chars`, `low_printable_ratio`, or `suspicious_glyphs`.

## Storage and lifecycle

Page artifacts are atomically written to `storage/text/{documentId}/pages/000001.json`. Lightweight job metadata is atomically written to `storage/metadata/text/{documentId}.json`. IDs and one-based page values are validated and resolved paths must remain under their designated roots.

The file-backed `DocumentTextJob` lifecycle is `queued -> processing -> completed|failed`. There is one process-wide document worker and one page subprocess at a time. Each subprocess has a timeout and an 8 MiB output limit. Upload inspection marks the PDF `ready`, then queues extraction asynchronously; PDF readiness never waits for text readiness.

At startup, `processing` and `queued` summaries become queued resumable work. Existing `ready` and `ocr_required` page artifacts remain readable and are counted rather than regenerated. Document deletion uses the existing per-document lifecycle lock and removes both text roots before removing document metadata.

## OCR-ready and AI-ready boundaries

`DisabledOcrProvider` implements the future `OcrProvider.processPage(input): Promise<OcrPageResult>` boundary by refusing execution. Pages needing OCR remain `ocr_required`. A future OCR provider should run as an independent worker.

PDF text and future OCR output are canonical extracted text. An AI system must not mutate it. Suspected OCR problems may only become an `ocr_verification_required`-style candidate issue. `ChapterTextBundle` is a data-only contract whose blocks retain `pdfPage` and `blockId` provenance; Phase 1 adds no AI endpoint, key, SDK, prompt, Skill, or MCP.

## Known limitations

Block classification is deliberately conservative and geometric reading order comes from Poppler. Multi-column layouts, tables, headers/footers, and footnotes may be imperfect. The quality heuristic cannot prove semantic correctness and intentionally sends marginal pages to future OCR rather than adding document-specific cleaning rules.
