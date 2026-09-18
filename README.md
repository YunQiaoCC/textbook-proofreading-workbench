# Legal Textbook Proofreading Workbench

An AI-assisted, human-reviewed workbench for proofreading legal textbooks. It
combines PDF reading and annotation with chapter-scoped editorial workflows,
while keeping human reviewers in final control.

AI does not automatically modify a PDF. AI findings are candidates only, and a
human reviewer retains final authority over every accepted, modified, or
rejected finding.

## Capabilities

- PDF reading and InkLayer annotation
- document- and chapter-scoped proofreading
- chapter-owner workflow for a shared seven-person workbench
- AI first-pass proofreading and Candidate Issue review
- accepted, modified, and rejected AI findings
- independent manual proofreading issues
- AI Candidate Issue overlays on the PDF
- workflow rollback with revision checks
- duplicate-PDF protection using SHA-256
- chapter and document deletion safeguards
- native PDF text extraction with quality checks
- optional legal-source retrieval integration

The application uses file-backed runtime persistence and is designed for one
Node.js API process. It is not a multi-tenant identity or permissions system.

## Human authority and AI boundary

The AI workflow produces reviewable hypotheses, not final errata. It cannot
accept its own findings, cannot edit source PDFs, and must preserve uncertainty
when extraction, sources, time, jurisdiction, case status, or scholarly debate
is unresolved. Human reviewers decide the final disposition and wording.

No AI or legal-source provider request is made merely by installing, building,
or running the test suite. Production smoke scripts that contact providers are
separate, explicit commands and are not part of the default tests.

## Architecture

- Vue 3 and Vite provide the browser workbench.
- InkLayer provides PDF rendering and annotation interactions.
- A single Node.js process serves authenticated JSON and PDF APIs.
- Runtime state is stored below a configured storage root outside Git.
- Chapter revisions protect concurrent edits within the shared workbench.
- Optional DeepSeek and legal-source retrieval integrations are server-side.

See [document text pipeline](docs/document-text-pipeline.md),
[AI review workflow](docs/ai-first-review-workflow.md), and
[AI runtime](docs/ai-review-runtime.md) for the detailed boundaries.

## Requirements

- Node.js 24 or a compatible supported Node.js release
- npm (the canonical package manager for this repository)
- Poppler tools (`pdfinfo`, `pdftotext`, and `pdftoppm`) for PDF inspection and
  native text extraction

## Local development

```bash
npm ci
npm run dev
```

The development server uses `http://127.0.0.1:8787` as its default API proxy.
Start the API separately when exercising server-backed features:

```bash
npm run server
```

Build the production bundle with:

```bash
npm run build
```

Do not use pnpm or Yarn for this repository. `package-lock.json` is committed
and is the reproducibility boundary for installs and deployment.

## Environment configuration

Copy `.env.example` to a local environment file outside version control and
set only the values needed by the selected features. Never commit real
credentials or production host details.

| Variable | Classification | Purpose |
| --- | --- | --- |
| `WORKBENCH_ACCESS_USERNAME` | required when authentication is enabled | Shared workbench login name |
| `WORKBENCH_ACCESS_PASSWORD` | required when authentication is enabled; production secret | Shared workbench password |
| `WORKBENCH_AUTH_REQUIRED` | production-only switch | Fail closed unless shared authentication is configured |
| `DOCUMENT_API_HOST`, `DOCUMENT_API_PORT` | optional; production deployment values are external | Node listen address and port |
| `DOCUMENT_STORAGE_ROOT` | optional; production value is external | Runtime persistence root |
| `MAX_DOCUMENT_SIZE`, `UPLOAD_CHUNK_SIZE`, `INSPECTION_TIMEOUT_MS` | optional | Upload and PDF inspection limits |
| `PDFINFO_BIN`, `PDFTOTEXT_BIN`, `PDFTOPPM_BIN` | optional | Poppler executable overrides |
| `VITE_API_PROXY_TARGET` | optional, development only | Vite API proxy target |
| `DEEPSEEK_API_KEY` | optional secret | Enables AI review requests |
| `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_TIMEOUT_MS` | optional | AI provider configuration |
| `AI_REVIEW_MAX_CHAPTER_CHARS` | optional | AI input size boundary |
| `YUANDIAN_API_KEY` | optional secret | Enables legal-source retrieval |
| `YUANDIAN_LAW_MCP_URL`, `YUANDIAN_MCP_TIMEOUT_MS` | optional | Retrieval endpoint and timeout |
| `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`, `LOGIN_RATE_LIMIT_WINDOW_MS`, `LOGIN_RATE_LIMIT_MAX_IDENTITIES` | optional | Login-only in-memory brute-force protection |

Production credentials belong in host-managed environment files with strict
permissions. The example values in `.env.example` are non-functional.

## Data and privacy boundary

The following are runtime or private data and are not part of this open-source
repository:

- uploaded PDFs
- extracted textbook text
- user annotations
- proofreading issues
- AI outputs
- retrieval evidence
- production storage and backups
- environment files and passwords
- API keys
- cookies, session IDs, and other session data

These values must remain in `storage/`, external environment files, or another
runtime persistence location and must never enter Git. The repository contains
only synthetic evaluation material and shape-only provider fixtures.

## Authentication and deployment

The application supports one shared account and concurrent independent browser
sessions. `POST /api/auth/login` has a bounded, process-memory, per-client rate
limit. The limiter applies only to login attempts; authenticated APIs are not
throttled. A successful login clears that client's failure bucket.

Deployment examples are sanitized templates. Keep real domains, server
addresses, service accounts, storage paths, credentials, and installed Nginx
or systemd configuration outside Git. See [deployment documentation](ops/DEPLOYMENT.md).

## Tests

The package scripts cover authentication, rate limiting, ingestion, duplicate
uploads, document and chapter lifecycle, PDF reads, proofreading, text
extraction, AI workflow and rollback, overlays, the legal skill, no-network
retrieval behavior, runtime behavior, packaging, and open-source guardrails.

```bash
npm run test:auth
npm run test:login-rate-limit
npm run test:open-source
npm run test:legal-skill
npm run build
```

Provider production smoke scripts are intentionally excluded because they make
external requests.

## Legal Textbook Proofreading Skill

`skills/legal-textbook-proofreading/` contains the review rules, legal rubric,
uncertainty and citation policies, output contract, JSON schema, and synthetic
evals. The Skill and evals are part of this open-source project. They contain no
API keys, private textbook text, provider responses, or third-party long-form
legal text.

## License

This repository is licensed under the MIT License. The original upstream
copyright and permission notice are preserved in [LICENSE](LICENSE), and
substantial modifications are identified there and in [NOTICE](NOTICE).
The current direct and lockfile dependency review is recorded in
[dependency licenses](docs/dependency-licenses.md).

## Acknowledgements

This project is based on
[inklayer-vue-starter](https://github.com/Laomai-codefee/inklayer-vue-starter),
originally created by Laomai and licensed under the MIT License. It has been
substantially modified into a legal-textbook proofreading workbench.

The PDF annotation interface uses
[inklayer-vue](https://github.com/Laomai-codefee/inklayer-vue).

This attribution does not imply that Laomai or InkLayer endorses this project.
The project is not presented as having been created from scratch.
