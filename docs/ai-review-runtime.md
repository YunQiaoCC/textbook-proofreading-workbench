# AI Review Runtime v0.1

The runtime is an asynchronous, single-process queue with concurrency one. The authoritative flow is:

`Chapter Text → Stage 1 screening → Retrieval Claims → Yuandian → Stage 2 judgement → server Candidate construction → Candidate validator → persistence → human review`.

Stage 1 receives a provider-neutral chapter bundle and the existing Legal Textbook Proofreading Skill files. It conservatively emits internal finding drafts and provider-neutral retrieval claims. The server verifies every page, block, and quoted source passage, assigns claim IDs, validates each claim, and then invokes the Yuandian adapter with bounded claim concurrency.

Stage 2 sees the original passages, validated findings, claims, retrieval statuses, normalized evidence, and the same Skill policy. It may discard findings. It can reference evidence only by a server-issued claim ID. DeepSeek does not directly call Yuandian, does not create authoritative evidence, and does not create Candidate IDs. The server maps references to normalized retrieval output, restores authoritative location fields, sets `humanResolution=pending`, generates the stable Candidate ID, applies verification gates, deduplicates, and validates the whole batch before persistence.

The bundle reports ready, suspicious, unavailable, and visually blank pages. Suspicious text is supplied with medium reliability and a warning. OCR-required or failed pages without text remain unavailable; text is never fabricated. Blank pages do not create a coverage gap. Coverage is complete only when no suspicious or unavailable pages exist. Zero usable text and chapters over `AI_REVIEW_MAX_CHAPTER_CHARS` fail before a model request; oversized chapters are never silently truncated.

Provider errors use finite sanitized codes and are never automatically retried. A user explicitly retries from `ai_failed`. On process startup, persisted `ai_running` workspaces are marked `ai_failed/runtime_interrupted`. Yuandian unavailable, error, not-found, and insufficient-evidence results remain evidence outcomes and do not fail the overall run; the final judgement must stay conservative.

Prompts, raw provider responses, raw Yuandian responses, API keys, and DeepSeek reasoning text are not persisted or sent to the browser. Only sanitized operational metadata, coverage, the Skill hash/version, counts, and token usage are stored. Human proofreading remains independently available throughout, and human review remains the final authority.
