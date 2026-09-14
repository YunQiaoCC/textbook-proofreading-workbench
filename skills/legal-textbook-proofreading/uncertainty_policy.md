# Uncertainty Policy v0.1

## Governing rule

Represent uncertainty explicitly. Evidence gaps must lower the strength of the judgement, not be filled with plausible-looking details.

## Required safeguards

1. A `verify` candidate can use `confirmed_error` only when `verificationStatus` is `verified`; `unverified`, `insufficient_evidence`, and `manual_check_required` cannot support that judgement.
2. Without actual source retrieval, do not claim verification or use `verificationStatus: verified`. Every `verified` candidate must include at least one evidence item: no evidence means no `verified` status.
3. `extractionReliability: low` requires `manual_check_required` and forbids `confirmed_error` until reliable visual, OCR, or human checking occurs.
4. A genuine academic dispute is not a unique-answer error. Use `academic_dispute` and ordinarily `ambiguous`, unless sufficient evidence shows the text falsely presents a contested view as the sole clear rule.
5. An unclear jurisdiction must not be assumed to be nationwide. Request qualification or human review.
6. An unclear temporal frame must not be evaluated automatically under current law. Determine whether the discussion is current, historical, or mixed.
7. Unknown case status must not be amplified. Distinguish ordinary, official/typical, guiding, and other special status only from reliable evidence.
8. Never invent legal text, article or docket numbers, dates, cases, sources, authors, page numbers, jurisdictions, or verification activity.
9. The visible published page is authoritative for final glyph-level adjudication, but lack of rendered-page evidence alone does not suppress a concrete, locatable, plausible, and actionable Stage 1 language-mechanics finding.

## Extraction reliability

- `high`: the passage is clear and page/block location is trustworthy.
- `medium`: the text is usable but signals such as fragmented layout, excessive CJK spacing, footnote ordering, or bounding-box anomalies may affect interpretation. Analysis may continue, but `humanReviewNote` should name the limitation when material.
- `low`: extraction, OCR, or page mapping prevents reliable reading. Do not strongly adjudicate the passage in v0.1.

Extraction reliability concerns the input and location. `confidence` concerns the legal or language judgement. Never merge them: a clearly extracted sentence may still present a low-confidence legal question, while a seemingly obvious typo in badly extracted text may require manual checking.

`high` extraction reliability means the text and location are generally usable; it does not prove that every extracted Unicode code point exactly represents the visible glyph. A difference that disappears under NFC or NFKC is not by itself evidence of a publication typo, and normalization must not overwrite authoritative extracted `originalText`.

Distinguish these outcomes:

- **Extraction-artifact-only suspicion:** the apparent defect is explained solely by normalization-equivalent or compatibility characters, homoglyph or variant code points, font/ToUnicode mapping, OCR/glyph mapping, or hidden text-layer behavior, and there is no independent textual or editorial reason to suspect the published page. Emit no issue.
- **Concrete editorial anomaly with visual confirmation unavailable:** the extracted text contains a locatable and plausible character, punctuation, spacing, dash, repetition, numbering, or textual-formatting problem that would be useful for a human to inspect. A Candidate is allowed. Use `manual_check_required` when the existing contract permits it, `ambiguous` or `likely_error`, and low/medium confidence; never use `verified` or `confirmed_error` solely from extraction. State in `humanReviewNote`: “需回看 PDF 页面确认，可能存在文本提取或版面映射影响。”

At Stage 1, which has no `verificationStatus`, preserve this distinction through `reasonDraft`, `humanReviewNote`, and conservative issue classification. Do not suppress a useful finding merely because visual input is unavailable.

## Choosing a judgement

- `confirmed_error`: use only when the text is reliable and the error is established without pretending missing verification occurred.
- `likely_error`: substantial indication exists, but a required fact/source check is pending or evidence is incomplete.
- `ambiguous`: the source sentence, legal frame, or scholarly status supports more than one reasonable reading.
- `correct_but_misleading`: literally defensible wording is likely to lead readers to a materially wrong impression.
- `correct_but_needs_qualification`: the core proposition is sound but a scope, exception, time, jurisdiction, or teaching limitation should be made explicit.

`no_error` is intentionally absent. In production, emit nothing; in evaluation, use `expectedIssue: null`.

## Escalation to human review

Use `humanReviewNote` for a concise, actionable limitation. Every candidate begins with `humanResolution: pending`; the model does not accept its own candidate. When uncertainty prevents a useful, locatable recommendation, do not emit an issue at all.

For unresolved visual language mechanics, retain the anomaly when it has concrete human-review value and satisfies the emission threshold. Suppress only extraction-artifact-only suspicions. Never combine `confirmed_error` with `high` confidence on extracted-text evidence alone.
