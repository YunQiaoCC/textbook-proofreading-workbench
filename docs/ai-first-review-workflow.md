# AI-first chapter review workflow

The AI is the first-pass proofreader for a complete chapter. The chapter's
human assignee is the responsible second-pass reviewer.

Human review is not merely approval of AI output. The responsible reviewer
must review every AI candidate, independently inspect the assigned chapter,
and add any omissions through the existing manual proofreading workspace.
Those human-authored additions do not require approval by a second reviewer.

## State machine

The AI review workspace is the authoritative source for the new workflow. Its
allowed transitions are intentionally finite:

```text
awaiting_ai -> ai_running
ai_running -> awaiting_human_review
ai_running -> ai_failed
ai_failed -> ai_running
awaiting_human_review -> human_review_in_progress
human_review_in_progress -> completed
```

An AI run may complete with zero candidates. That still leads to
`awaiting_human_review`, because finding no candidate does not waive the human
review. A chapter becomes `completed` only when the responsible reviewer
explicitly completes it. Resolving every AI candidate only opens that gate; it
does not advance the stage automatically.

AI reruns cannot overwrite review work. Version 0.1 permits retry only after
`ai_failed`, and only while human review has not begun and every stored
resolution remains `pending`.

## Separate persistence

AI review state is stored per chapter at:

```text
storage/metadata/ai-reviews/<documentId>/<chapterId>.json
```

It has its own optimistic `revision`, atomic JSON writes, and lifecycle lock.
It is separate from `storage/metadata/proofreading`, whose `issues` continue to
represent human-authored proofreading issues. AI candidates are never copied
into that array.

Each stored candidate entry preserves the immutable v0.1 Skill candidate and
stores human action separately:

```text
candidate: original AI candidate with humanResolution=pending
resolution: pending | accepted | modified | rejected
```

Modified resolutions contain a provider-neutral human result without adopting
legacy UI-only annotation, verifier, or status fields. Rejected candidates are
retained for false-positive analysis. Document deletion removes the complete
AI review directory, and the existing metadata backup already includes it.

## Reviewer identity and compatibility

When a chapter has `assigneeName`, human-review actions require the same
`reviewerName`. This is a workflow contract, not an authentication boundary;
the current product still accepts the name from the client.

The legacy `Chapter.status` enum and existing `ProofreadingIssue` schema are
unchanged. There is no automatic projection between legacy chapter status and
the AI review stage in this foundation release.

AI lifecycle methods remain server-internal until a real model runtime exists.
Only read and human-review actions have HTTP routes. There is no mock, seed,
debug, or public AI-generation endpoint.
