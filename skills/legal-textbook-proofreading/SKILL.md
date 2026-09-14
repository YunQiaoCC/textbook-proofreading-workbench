---
name: legal-textbook-proofreading
description: Review extracted legal textbook passages for language, legal-source, temporal, case, citation, consistency, and teaching-context issues, emitting human-reviewable candidate issues. Use for legal textbook proofreading; do not use as legal advice or to auto-edit source material.
---

# Legal Textbook Proofreading

## Purpose

Produce conservative, locatable candidate issues that improve a legal textbook's accuracy and reader understanding. Human editors make the final decision.

## When to activate

Use for passage-, page-, chapter-, or cross-chapter review of legal teaching material when extracted text and document location are available. Apply it to language mechanics, terminology, legal sources and dates, cases/data/citations, historical framing, jurisdiction, and scholarly or pedagogical judgement.

## Scope

- Review extracted text in its chapter, temporal, jurisdictional, and teaching context.
- Classify only issues that meet the emission threshold.
- Preserve source uncertainty and extraction limitations.
- Emit the v0.1 candidate contract in [output_contract.md](output_contract.md).

## Out-of-scope

Do not provide legal advice, assess litigation risk, retrieve sources unless a separate authorized tool is available, invoke model/provider APIs, run OCR, change PDF extraction, modify source textbooks, persist product issues, or accept candidates on a human's behalf.

## Core principles

1. Candidate issue, not final erratum.
2. Human resolution is authoritative; every new candidate is `pending`.
3. Extraction reliability and judgement confidence are independent.
4. No retrieval means no claim of verification.
5. Protect legitimate scholarly positions, historical accuracy, pedagogical simplification, and jurisdictional limits.
6. Never treat one ordinary judgment as a universal rule.
7. Fewer well-supported candidates are better than speculative correction.
8. Proofreading evaluates the visible published page, not merely its hidden or extracted PDF text layer.
9. Human review is authoritative. Lack of rendered-page evidence does not by itself require suppressing a concrete, locatable, plausible, and actionable proofreading anomaly.

## Review unit

Review the smallest meaningful passage plus enough neighboring text to identify definitions, section purpose, time, jurisdiction, citations, and teaching level. Retain `documentId`, `chapterId`, one-based `pdfPage`, and `blockId` when available. For consistency findings, inspect the referenced comparison passage before emitting.

## Review Workflow

1. Assess extraction reliability from text quality, block order, bounding boxes, spacing, and page mapping. For character-, punctuation-, spacing-, dash-, numbering-, or formatting-level suspicions, distinguish a likely extraction-only artifact from an anomaly worth inexpensive human review.
2. Establish current/historical/mixed context, jurisdiction, case status, and whether the passage states law or scholarship.
3. Scan the review dimensions in [legal_rubric.md](legal_rubric.md); passes are dimensions, not model-call counts.
4. Assign one `ruleType`, one controlled `issueType`, textbook-impact severity, and retrieval level.
5. Apply [citation_policy.md](citation_policy.md) and [uncertainty_policy.md](uncertainty_policy.md).
6. Emit only if the candidate is locatable, explainable, actionable, and honest about verification.
7. Validate against [schema/issue.schema.json](schema/issue.schema.json). Omit correct items.

## Rule Types

- `static`: clear text/structure issue needing no external evidence.
- `verify`: a strong conclusion requires reliable external sources.
- `judgement`: resolution requires legal, scholarly, or teaching-context analysis.

Extraction uncertainty is not a rule type. Detailed definitions and severity guidance are in [legal_rubric.md](legal_rubric.md).

## Retrieval

Set `retrievalRequired` to `must`, `should`, or `no` using [legal_rubric.md](legal_rubric.md). Article/source/status/case/data/jurisdictional claims generally require retrieval. If retrieval did not occur, do not set `verified` and do not fabricate evidence. Read [citation_policy.md](citation_policy.md) before evaluating authority or citations.

## Issue emission threshold

Report a defect or material qualification need, not preference. Do not report purely aesthetic formatting. Do not report a historical statement that is correct for its period, an acceptable defined abbreviation, a harmless teaching simplification, or a contestable view merely because it is non-mainstream. When uncertainty prevents a useful candidate, emit nothing.

For Stage 1 screening, favor actionable recall over silent suppression when human review can cheaply resolve uncertainty. Keep a finding when extracted text contains a concrete, locatable, plausible editorial anomaly with real human-review value, including a possible character error, repeated or missing punctuation, abnormal spacing, dash or hyphen substitution, repeated text, numbering anomaly, obvious word error, or meaning-affecting textual formatting anomaly. Lack of rendered-page evidence alone is not a reason to suppress it. Mark the finding conservatively through `reasonDraft`, `humanReviewNote`, and issue classification, and never claim visual confirmation.

Suppress a finding only when the suspected defect is supported solely by a likely extraction-layer artifact and there is no independent textual or editorial reason to suspect a publication-layer problem. Extraction-only signals include Unicode normalization-equivalent characters, compatibility characters, homoglyph or variant code points, ToUnicode or font-mapping artifacts, OCR or glyph-mapping artifacts, and hidden-text-layer differences. Preserve authoritative `originalText` exactly as extracted; normalization is a judgement safeguard, never a source-text rewrite.

When an emitted language-mechanics anomaly still needs visual confirmation, downstream judgement must remain conservative: do not mark it `verified`, do not use `confirmed_error` solely from extracted text, keep confidence at `medium` or `low`, and use `manual_check_required` when the existing contract permits it. The `humanReviewNote` should state: “需回看 PDF 页面确认，可能存在文本提取或版面映射影响。” Do not emit speculative alternatives that fail the concrete, locatable, plausible, and actionable threshold.

## Human Review

AI never sets `accepted`. Use `humanReviewNote` for actionable extraction, evidence, temporal, jurisdictional, case-status, or dispute limitations. A future product integration may preserve and map resolved candidates, but v0.1 neither changes the existing human `ProofreadingIssue` nor implements that mapping.

## Companion files

- [output_contract.md](output_contract.md): fields, stable IDs, evidence, and integration boundary.
- [legal_rubric.md](legal_rubric.md): review dimensions, severity, triggers, and legal-textbook safeguards.
- [citation_policy.md](citation_policy.md): normative/academic authority and source evidence.
- [uncertainty_policy.md](uncertainty_policy.md): judgement limits and extraction safeguards.
- [schema/issue.schema.json](schema/issue.schema.json): normative machine schema.
- [evals/cases.jsonl](evals/cases.jsonl) and `evals/golden/`: synthetic behavioral checks.

## Output

Return only a JSON array of candidate issues conforming to the schema, unless the caller explicitly requests a human-readable review summary. An empty array means no reportable candidate. Never include negative controls or correct passages in production output.

