# Citation and Authority Policy v0.1

## Two independent authority axes

Do not collapse normative and academic authority into one ranking. A source can be strong for one question and irrelevant to the other.

### Normative authority

Use this axis to answer what law currently provides, within the relevant time and jurisdiction. Prefer official promulgating or publishing sources and distinguish:

- laws;
- administrative regulations;
- judicial interpretations;
- department rules;
- local regulations and rules;
- normative documents;
- guiding cases;
- official/typical cases;
- ordinary court judgments.

A guiding case is not legislation. An official or typical case does not automatically establish a generally binding rule. An individual judgment cannot, by itself, justify a universal proposition. Record the source's jurisdiction, effective status, and limitations when they affect the conclusion.

### Academic authority

Use this axis for doctrinal disputes, majority/minority views, theory and concepts, authorial positions, comparative law, and legal history. Consider the fit and quality of journals, scholarly monographs, established textbooks, research articles, dissertations, and reviews. Reputation alone does not turn a scholarly claim into positive law.

## Retrieval level

Use the `must`, `should`, and `no` triggers in [legal_rubric.md](legal_rubric.md). Retrieval level describes the need for checking, not whether checking has occurred.

## Verification and evidence

- Without actual source access, never write `verified` or claim that a proposition was checked.
- Every `verified` candidate requires at least one evidence item that directly supports the result; no evidence means no `verified` status.
- A citation that merely mentions the topic is not support; state the exact supported proposition in `supports`.
- If sources conflict, are incomplete, secondary where primary authority is necessary, or do not establish the relevant time/jurisdiction, use `insufficient_evidence` or retain `unverified`.
- Evidence titles, authors/issuers, dates, article/docket numbers, page numbers, and URLs must not be invented.
- `citationOrUrl` may hold a conventional legal citation or a URL. Do not manufacture a URL when a citation is sufficient.

## Source-type control

The v0.1 schema controls source types for consistent evaluation: `law`, `administrative_regulation`, `judicial_interpretation`, `department_rule`, `local_regulation`, `guiding_case`, `official_case`, `court_judgment`, `normative_document`, `academic_article`, `book`, `textbook`, `official_data`, and `other`. Use `other` sparingly and explain material limits. Extend the enum only in a versioned contract revision.

## Citation mismatch

Review the legal proposition separately from its citation. A correct conclusion with an unrelated or inaccurate footnote can still produce `citation` or `legal_source_mismatch`; do not rewrite the correct conclusion as a substantive legal error.

## Citation marker placement

Citation-marker placement is a project-specific textbook editing and typesetting rule. It is not a check of the cited source's authenticity, bibliographic identity, page number, author, publication, or substantive legal accuracy. A clear placement issue is normally `issueType=citation`, `ruleType=static`, `retrievalRequired=no`, and `verificationStatus=not_required`.

Apply the following rules only after determining the semantic scope of the citation marker:

1. **Whole-sentence citation.** When the citation supports the complete sentence, place the marker after the sentence-final punctuation, including `。`, `？`, and `！`.
   - Correct: `劳动权是劳动者依法享有的重要权利。[1]`
   - Incorrect: `劳动权是劳动者依法享有的重要权利[1]。`
2. **Partial-sentence citation.** When the citation supports only a word group, clause, or local proposition, place the marker immediately after the supported material and before the following comma, semicolon, full stop, or other punctuation.
   - Correct: `劳动关系具有从属性[1]，这是其重要特征之一。`
   - Incorrect: `劳动关系具有从属性，[1]这是其重要特征之一。`
3. **Term or direct-quotation citation.** When the citation supports only a term, concept, or direct quotation, place the marker immediately after the supported term or closing quotation mark and before any following punctuation.
   - Correct: `学者将其称为“从属性”[1]，并据此展开分析。`
   - Incorrect: `学者将其称为“从属性”，[1]并据此展开分析。`

Do not apply these rules mechanically:

- If the citation scope cannot be determined, do not report a `confirmed_error` merely from marker position. Use an ambiguity/manual-review candidate only when it remains concrete and useful; otherwise emit no candidate.
- A marker near the end of a sentence may support only the immediately preceding local proposition. Decide scope from semantics, not punctuation alone.
- PDF text extraction may reorder superscripts, split markers into separate blocks, lose superscript glyphs, or separate punctuation from markers. Follow the extraction safeguards in [uncertainty_policy.md](uncertainty_policy.md).
- Do not force this project convention when the material clearly declares and consistently applies another reasonable citation style.
- The existence of an ordinary footnote is not an error. Do not turn bibliographic authenticity or identity questions into static placement issues.

Use `punctuation` only when the problem is punctuation itself and does not depend on citation scope. Use `format` only for a purely visual layout problem. Do not retrieve external evidence for citation-marker placement.
