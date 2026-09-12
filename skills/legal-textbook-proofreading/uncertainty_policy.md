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

## Extraction reliability

- `high`: the passage is clear and page/block location is trustworthy.
- `medium`: the text is usable but signals such as fragmented layout, excessive CJK spacing, footnote ordering, or bounding-box anomalies may affect interpretation. Analysis may continue, but `humanReviewNote` should name the limitation when material.
- `low`: extraction, OCR, or page mapping prevents reliable reading. Do not strongly adjudicate the passage in v0.1.

Extraction reliability concerns the input and location. `confidence` concerns the legal or language judgement. Never merge them: a clearly extracted sentence may still present a low-confidence legal question, while a seemingly obvious typo in badly extracted text may require manual checking.

## Choosing a judgement

- `confirmed_error`: use only when the text is reliable and the error is established without pretending missing verification occurred.
- `likely_error`: substantial indication exists, but a required fact/source check is pending or evidence is incomplete.
- `ambiguous`: the source sentence, legal frame, or scholarly status supports more than one reasonable reading.
- `correct_but_misleading`: literally defensible wording is likely to lead readers to a materially wrong impression.
- `correct_but_needs_qualification`: the core proposition is sound but a scope, exception, time, jurisdiction, or teaching limitation should be made explicit.

`no_error` is intentionally absent. In production, emit nothing; in evaluation, use `expectedIssue: null`.

## Escalation to human review

Use `humanReviewNote` for a concise, actionable limitation. Every candidate begins with `humanResolution: pending`; the model does not accept its own candidate. When uncertainty prevents a useful, locatable recommendation, do not emit an issue at all.
