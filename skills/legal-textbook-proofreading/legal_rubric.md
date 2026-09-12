# Legal Textbook Proofreading Rubric v0.1

## Decision objective

Evaluate accuracy and reader understanding in a legal textbook. This is editorial review, not legal advice or litigation-risk scoring. Severity measures impact on the textbook, and no `legalRisk` field exists in v0.1.

## Review dimensions

The passes below are review dimensions, not a required number of model calls. One reading may cover several passes, and v0.1 defines no model integration.

### Pass A: Language mechanics

Check typos, punctuation, wording, and obvious repetition. Emit only clear publication issues; stylistic preference alone is insufficient.

### Pass B: Terminology and internal consistency

Check legal concepts, defined terms, abbreviations, and consistency within and across chapters. Distinguish a deliberate contextual definition from an accidental conflict.

### Pass C: Legal source identity

Check official names, article numbers, source type, quoted propositions, and mismatched citations. These claims normally require authoritative retrieval.

### Pass D: Temporal validity

Check commencement, amendment, repeal, supersession, transition rules, and old/new-law framing. Read the surrounding section before deciding whether a sentence describes current or historical law.

### Pass E: Cases, data, and citations

Separate case existence, docket/citation accuracy, actual holding, claimed proposition, and any special official status. Check data provenance and whether a citation supports the stated conclusion.

### Pass F: Cross-chapter consistency

Compare repeated concepts, sources, cases, data, and conclusions. Do not report a difference that is justified by time, jurisdiction, audience level, or a stated change in analytical frame.

### Pass G: Legal and academic judgement

Assess overstatement, contested doctrine, pedagogical simplification, missing qualifications, and the author's expressed position. Protect plausible scholarly positions from being normalized into a single “correct” view.

## Rule types

- `static`: a high-reliability textual or structural determination needing no external evidence, such as a clear typo, duplicate, punctuation fault, numbering anomaly, or unmistakable internal term conflict.
- `verify`: a strong conclusion depends on reliable external sources, including source wording/status, dates, names/numbers, cases, data, or territorial application.
- `judgement`: resolution needs legal meaning, doctrine, or teaching context rather than mechanical fact matching.

Extraction reliability is an independent field, never a fourth rule type.

## Severity

- `critical`: a plainly wrong core legal proposition likely to systematically mislead readers.
- `major`: an important legal rule, source status, case proposition, or concept is materially wrong.
- `minor`: a localized defect needs correction but does not change the principal legal understanding.
- `clarification`: the passage may be correct but is ambiguous, under-qualified, or pedagogically misleading.

## Retrieval triggers

### Must

Use `must` for statutory wording or article numbers; formal legal names; commencement, amendment, repeal, or current status; judicial-interpretation status; case identity/docket/holding; statistics; territorial scope of local rules; strong normative words such as “依法”, “必须”, “不得”, or “一律”; and suspected source miscitation.

### Should

Use `should` for concept boundaries, general/special-law relations, scholarly consensus or disputes, possible case overgeneralization, correct claims needing qualifications, foreign/comparative law, and historical law.

### No

Use `no` for clear typos, punctuation, duplication, purely internal cross-references, and internal formatting consistency unrelated to an external fact.

`must` means retrieval is required for a strong conclusion; it does not claim retrieval occurred. In this foundation release no retrieval tool is available, so synthetic `verify` candidates are not `verified`.

## Legal textbook safeguards

### Pedagogical simplification

Simplification is not itself error. Do not emit an issue when it preserves the core legal meaning for the intended teaching level. When simplification creates a false rule, use `pedagogical_clarification` or `overstrong_claim`, calibrated to impact.

### Scholarly positions

Do not label a minority theory, the author's own theory, a methodological difference, or a genuine academic dispute as wrong merely because it differs from a common answer. Distinguish normatively/factually false claims from contestable scholarship. If that distinction cannot be established, use `ambiguous` and/or `disputeStatus: academic_dispute`; ordinarily do not use `confirmed_error`.

### Historical law

Ask whether the author describes the law at the historical time or claims current validity. A historically accurate account is not an issue merely because current law differs. Use `temporalContext` to make this frame explicit when it matters.

### Cases

Never infer a universal legal rule from one judgment alone. Separately assess authenticity, citation, holding, degree of generalization, jurisdiction, and official status. A guiding case is not statutory text; an official or typical case is not automatically a guiding case; an ordinary judgment is not automatically normative authority.

### Jurisdiction

Do not default an unstated jurisdiction to nationwide application. A local, foreign, or comparative rule must be framed within its actual scope.

## Issue threshold

Emit only a concrete, locatable candidate that a human can act on. Prefer no issue over speculative over-correction. If the passage is broadly correct and the concern is a necessary limitation, prefer `correct_but_needs_qualification` with `clarification` severity. Apply [uncertainty_policy.md](uncertainty_policy.md) whenever source, extraction, temporal, jurisdictional, case-status, or scholarly uncertainty remains.

## Design note

The structure was informed by `scientific-textbook-proofreading-skill`, `academic-proofreading-agent`, `JakobThumm/proofreading`, and `legal-research-skill`. All rules here are independently authored for this project's legal textbook use case.

