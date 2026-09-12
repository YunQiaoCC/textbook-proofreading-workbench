# Candidate Issue Output Contract v0.1

## Status and boundary

The skill emits **Candidate Issues**, not final errata. A candidate records a reviewable hypothesis for a human editor. Correct passages are omitted from production output; `expectedIssue: null` exists only in synthetic evaluation data.

This contract is independent of the product's existing human `ProofreadingIssue`. It does not replace that type, its statuses, annotations, repository, or API. A future integration may map an AI candidate into the product workflow only after human resolution, while retaining both the original candidate and any human-modified result. v0.1 defines no mapper and performs no persistence.

## Emission threshold

Emit a candidate only when it is:

- locatable through `documentId`, `chapterId`, `pdfPage`, and `blockId` when available;
- explainable through a concrete reason and actionable suggestion;
- classifiable under the controlled enums;
- reviewable without pretending that unavailable evidence was checked.

Do not emit praise, correct items, purely aesthetic formatting preferences, or speculative alternatives with no material effect on legal accuracy or reader understanding. `format` is reportable only when it affects meaning, legal expression, reliable location, or ordinary publication correctness.

## Required fields

The normative machine contract is [schema/issue.schema.json](schema/issue.schema.json). `schemaVersion` is `0.1`. Required fields are:

`schemaVersion`, `id`, `documentId`, `chapterId`, `pdfPage`, `originalText`, `issueType`, `ruleType`, `severity`, `extractionReliability`, `verificationStatus`, `retrievalRequired`, `evidence`, `judgement`, `suggestion`, `reason`, `confidence`, and `humanResolution`.

`blockId`, `temporalContext`, `disputeStatus`, `jurisdictionScope`, `humanReviewNote`, and `correctedText` are optional because they are not meaningful or available in every review unit. Omission must not be used to hide known uncertainty.

## Stable issue ID

IDs are deterministic and opaque: `ltp_<16 lowercase hex characters>`.

1. Normalize `originalText` with Unicode NFKC, collapse whitespace to one ASCII space, and trim.
2. Compute the lowercase SHA-256 hex digest of the normalized text (`textFingerprint`).
3. Join `documentId`, `chapterId`, decimal `pdfPage`, `blockId` or the empty string, `issueType`, and `textFingerprint` with LF characters.
4. SHA-256 the joined value and use its first 16 lowercase hex characters after `ltp_`.

This is a deduplication key, not a sequence number or security boundary. It deliberately avoids chapter-local counters such as `CH01-001` and never embeds the passage itself. A location or material source-text change may produce a new ID.

## Evidence contract

`evidence` is always an array. Static issues may use an empty array. Any candidate marked `verified` must contain at least one evidence item: no evidence means no `verified` status. Each item contains:

- `sourceType`: a controlled v0.1 source kind;
- `authorityAxis`: `normative`, `academic`, or `other`;
- `title`: the source title;
- `supports`: exactly what proposition the item supports;
- optional `issuerOrAuthor`, `citationOrUrl`, `publicationDate`, `effectiveStatus`, `jurisdiction`, and `limitations`.

The controlled `sourceType` list is versioned rather than open-ended so downstream validation remains reliable; new types require an explicit schema revision. `other` is the narrow escape hatch and should be explained in `limitations`.

## Human resolution

The states are `pending`, `accepted`, `modified`, and `rejected`. Every newly emitted AI candidate is `pending`. AI must never set `accepted`. `modified` means a future product must preserve the original candidate as well as the human result.

## Cross-field invariants

- `static` normally requires no retrieval and uses `not_required`.
- `verify` requires real source checking before `verified`; without completed retrieval it remains `unverified`, `insufficient_evidence`, or `manual_check_required` and cannot use `confirmed_error`.
- Any `verified` candidate requires non-empty evidence.
- `extractionReliability: low` requires `manual_check_required` and forbids `confirmed_error` until reliable visual, OCR, or human verification exists.
- A new candidate must have `humanResolution: pending`.
- Evidence and jurisdiction/temporal/dispute fields must describe what was actually established, not what was assumed.
