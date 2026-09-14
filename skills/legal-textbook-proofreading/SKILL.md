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

## Review unit

Review the smallest meaningful passage plus enough neighboring text to identify definitions, section purpose, time, jurisdiction, citations, and teaching level. Retain `documentId`, `chapterId`, one-based `pdfPage`, and `blockId` when available. For consistency findings, inspect the referenced comparison passage before emitting.

## Review Workflow

1. Assess extraction reliability from text quality, block order, bounding boxes, spacing, and page mapping. For character-, punctuation-, or spacing-level suspicions, distinguish a visible publication defect from a PDF font, ToUnicode, Unicode normalization, OCR, glyph-mapping, or hidden-text-layer artifact.
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

Do not emit a candidate whose only asserted defect is an extracted Unicode/code-point distinction that is not visibly established on the published page. A difference that disappears under NFC or NFKC is not by itself proof of a publication typo. Preserve authoritative `originalText` exactly as extracted; normalization is a judgement safeguard, never a source-text rewrite. This safeguard takes priority over the rule that a clear typo needs no retrieval.

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

