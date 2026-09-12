#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

BASE_URL="${BASE_URL:-https://proofread.kycloudmimi.site}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
TMP_ROOT="$(mktemp -d -t textbook-production-smoke-XXXXXX)"
NETRC_FILE="$TMP_ROOT/netrc"

cleanup() {
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

read -r -s BASIC_AUTH_PASSWORD
printf 'machine proofread.kycloudmimi.site login proofreader password %s\n' "$BASIC_AUTH_PASSWORD" > "$NETRC_FILE"
chmod 600 "$NETRC_FILE"
unset BASIC_AUTH_PASSWORD

curl_status() {
  curl --max-time 45 --netrc-file "$NETRC_FILE" -sS -o /dev/null -w '%{http_code}' "$@"
}

json_value() {
  local file="$1"
  local expression="$2"
  "$NODE_BIN" -e "const fs=require('node:fs'); const x=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(${expression})" "$file"
}

json_request() {
  local output="$1"
  shift
  curl --max-time 45 --netrc-file "$NETRC_FILE" -sS -o "$output" -w '%{http_code}' "$@"
}

# Create a valid two-page, uncompressed PDF without using any production
# document. It gives the chapter smoke a real page boundary to validate.
PDF_FILE="$TMP_ROOT/production-smoke.pdf"
"$NODE_BIN" -e '
const fs = require("node:fs")
const output = process.argv[1]
const pageBody = "BT /F1 18 Tf 72 720 Td (Production smoke fixture.) Tj ET"
const objects = [
  null,
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
  "<< /Length " + Buffer.byteLength(pageBody) + " >>\nstream\n" + pageBody + "\nendstream",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
const chunks = [Buffer.from("%PDF-1.4\n%\xff\xff\xff\xff\n")]
const offsets = [0]
for (let id = 1; id < objects.length; id += 1) {
  offsets[id] = Buffer.concat(chunks).length
  chunks.push(Buffer.from(id + " 0 obj\n"), Buffer.from(objects[id]), Buffer.from("\nendobj\n"))
}
const xrefOffset = Buffer.concat(chunks).length
let xref = "xref\n0 " + objects.length + "\n0000000000 65535 f \n"
for (let id = 1; id < objects.length; id += 1) {
  xref += String(offsets[id]).padStart(10, "0") + " 00000 n \n"
}
xref += "trailer\n<< /Size " + objects.length + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n"
chunks.push(Buffer.from(xref))
fs.writeFileSync(output, Buffer.concat(chunks))
' "$PDF_FILE"

UPLOAD_CREATE="$TMP_ROOT/upload-create.json"
PDF_SIZE="$(stat -c '%s' "$PDF_FILE")"
UPLOAD_CREATE_CODE="$(json_request "$UPLOAD_CREATE" -X POST -H 'content-type: application/json' --data "{\"filename\":\"production-smoke.pdf\",\"byteSize\":$PDF_SIZE,\"mimeType\":\"application/pdf\"}" "$BASE_URL/api/uploads")"
test "$UPLOAD_CREATE_CODE" = 201
UPLOAD_ID="$(json_value "$UPLOAD_CREATE" 'x.id')"
EXPECTED_PARTS="$(json_value "$UPLOAD_CREATE" 'x.expectedParts')"

for ((part = 1; part <= EXPECTED_PARTS; part += 1)); do
  PART_FILE="$TMP_ROOT/part-$part"
  dd if="$PDF_FILE" of="$PART_FILE" bs=16777216 skip=$((part - 1)) count=1 status=none
  PART_CODE="$(curl_status -X PUT -H 'content-type: application/octet-stream' --data-binary "@$PART_FILE" "$BASE_URL/api/uploads/$UPLOAD_ID/parts/$part")"
  test "$PART_CODE" = 201
done

UPLOAD_COMPLETE="$TMP_ROOT/upload-complete.json"
UPLOAD_COMPLETE_CODE="$(json_request "$UPLOAD_COMPLETE" -X POST "$BASE_URL/api/uploads/$UPLOAD_ID/complete")"
test "$UPLOAD_COMPLETE_CODE" = 200
DOCUMENT_ID="$(json_value "$UPLOAD_COMPLETE" 'x.document.id')"
test "$(json_value "$UPLOAD_COMPLETE" 'x.document.processingStatus')" = ready
test "$(json_value "$UPLOAD_COMPLETE" 'x.document.pageCount')" = 2

CHAPTER_A_FILE="$TMP_ROOT/chapter-a.json"
CHAPTER_A_CODE="$(json_request "$CHAPTER_A_FILE" -X POST -H 'content-type: application/json' --data '{"title":"Production Chapter A","startPdfPage":1,"endPdfPage":1,"order":1,"assigneeName":"A","status":"in_progress"}' "$BASE_URL/api/documents/$DOCUMENT_ID/chapters")"
test "$CHAPTER_A_CODE" = 201
CHAPTER_A_ID="$(json_value "$CHAPTER_A_FILE" 'x.id')"

CHAPTER_B_FILE="$TMP_ROOT/chapter-b.json"
CHAPTER_B_CODE="$(json_request "$CHAPTER_B_FILE" -X POST -H 'content-type: application/json' --data '{"title":"Production Chapter B","startPdfPage":2,"endPdfPage":2,"order":2,"assigneeName":"B","status":"not_started"}' "$BASE_URL/api/documents/$DOCUMENT_ID/chapters")"
test "$CHAPTER_B_CODE" = 201
CHAPTER_B_ID="$(json_value "$CHAPTER_B_FILE" 'x.id')"

CHAPTERS_FILE="$TMP_ROOT/chapters.json"
CHAPTERS_CODE="$(json_request "$CHAPTERS_FILE" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters")"
test "$CHAPTERS_CODE" = 200
test "$(json_value "$CHAPTERS_FILE" 'x.chapters.length')" = 2

WORKSPACE_A_FILE="$TMP_ROOT/workspace-a.json"
WORKSPACE_B_FILE="$TMP_ROOT/workspace-b.json"
WORKSPACE_A_CODE="$(json_request "$WORKSPACE_A_FILE" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_A_ID/proofreading")"
WORKSPACE_B_CODE="$(json_request "$WORKSPACE_B_FILE" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_B_ID/proofreading")"
test "$WORKSPACE_A_CODE" = 200
test "$WORKSPACE_B_CODE" = 200
test "$(json_value "$WORKSPACE_A_FILE" 'x.revision')" = 0
test "$(json_value "$WORKSPACE_B_FILE" 'x.revision')" = 0

A_BODY='{"baseRevision":0,"annotations":[{"id":"production-annotation-a","kind":"highlight","payload":{"selectedText":"synthetic-a"}}],"issues":[{"id":"production-issue-a","annotationId":"production-annotation-a","pdfPage":1,"printedPage":"","originalText":"synthetic-a","category":"typo","suggestion":"synthetic-b","reason":"","status":"pending","reviewer":"smoke","verifier":"","createdAt":"2026-09-12T00:00:00.000Z","updatedAt":"2026-09-12T00:00:00.000Z"}]}'
B_BODY='{"baseRevision":0,"annotations":[{"id":"production-annotation-b","kind":"highlight","payload":{"selectedText":"synthetic-b"}}],"issues":[{"id":"production-issue-b","annotationId":"production-annotation-b","pdfPage":2,"printedPage":"","originalText":"synthetic-b","category":"typo","suggestion":"synthetic-c","reason":"","status":"pending","reviewer":"smoke","verifier":"","createdAt":"2026-09-12T00:00:00.000Z","updatedAt":"2026-09-12T00:00:00.000Z"}]}'

A_SAVE_FILE="$TMP_ROOT/a-save.json"
B_SAVE_FILE="$TMP_ROOT/b-save.json"
A_SAVE_CODE="$(json_request "$A_SAVE_FILE" -X PUT -H 'content-type: application/json' --data "$A_BODY" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_A_ID/proofreading")"
B_SAVE_CODE="$(json_request "$B_SAVE_FILE" -X PUT -H 'content-type: application/json' --data "$B_BODY" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_B_ID/proofreading")"
test "$A_SAVE_CODE" = 200
test "$B_SAVE_CODE" = 200
test "$(json_value "$A_SAVE_FILE" 'x.revision')" = 1
test "$(json_value "$B_SAVE_FILE" 'x.revision')" = 1

A2_BODY='{"baseRevision":1,"annotations":[{"id":"production-annotation-a","kind":"highlight","payload":{"selectedText":"synthetic-a"}}],"issues":[{"id":"production-issue-a","annotationId":"production-annotation-a","pdfPage":1,"printedPage":"","originalText":"synthetic-a","category":"typo","suggestion":"synthetic-b","reason":"","status":"pending","reviewer":"smoke","verifier":"","createdAt":"2026-09-12T00:00:00.000Z","updatedAt":"2026-09-12T00:00:00.000Z"}]}'
A2_SAVE_FILE="$TMP_ROOT/a-save-2.json"
A2_SAVE_CODE="$(json_request "$A2_SAVE_FILE" -X PUT -H 'content-type: application/json' --data "$A2_BODY" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_A_ID/proofreading")"
test "$A2_SAVE_CODE" = 200
test "$(json_value "$A2_SAVE_FILE" 'x.revision')" = 2
test "$(json_value "$B_SAVE_FILE" 'x.revision')" = 1

STALE_BODY='{"baseRevision":2,"annotations":[{"id":"production-annotation-a","kind":"highlight","payload":{"selectedText":"synthetic-a"}}],"issues":[{"id":"production-issue-a","annotationId":"production-annotation-a","pdfPage":1,"printedPage":"","originalText":"synthetic-a","category":"typo","suggestion":"synthetic-b","reason":"","status":"pending","reviewer":"smoke","verifier":"","createdAt":"2026-09-12T00:00:00.000Z","updatedAt":"2026-09-12T00:00:00.000Z"}]}'
STALE_FIRST_FILE="$TMP_ROOT/stale-first.json"
STALE_SECOND_FILE="$TMP_ROOT/stale-second.json"
STALE_FIRST_CODE="$(json_request "$STALE_FIRST_FILE" -X PUT -H 'content-type: application/json' --data "$STALE_BODY" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_A_ID/proofreading")"
STALE_SECOND_CODE="$(json_request "$STALE_SECOND_FILE" -X PUT -H 'content-type: application/json' --data "$STALE_BODY" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_A_ID/proofreading")"
test "$STALE_FIRST_CODE" = 200
test "$STALE_SECOND_CODE" = 409

FILE_HEADERS="$TMP_ROOT/file-headers"
RANGE_HEADERS="$TMP_ROOT/range-headers"
FILE_URL="$BASE_URL/api/documents/$DOCUMENT_ID/file"
FULL_CODE="$(curl_status -D "$FILE_HEADERS" "$FILE_URL")"
HEAD_CODE="$(curl_status -I "$FILE_URL")"
ETAG="$(awk 'tolower($1) == "etag:" { gsub("\r", "", $2); print $2 }' "$FILE_HEADERS")"
LAST_MODIFIED="$(awk 'tolower($1) == "last-modified:" { $1=""; sub(/^ /, ""); gsub("\r", ""); print }' "$FILE_HEADERS")"
test "$FULL_CODE" = 200
test "$HEAD_CODE" = 200
test -n "$ETAG"
test -n "$LAST_MODIFIED"

RANGE_CODE="$(curl_status -D "$RANGE_HEADERS" -H 'Range: bytes=0-99' "$FILE_URL")"
test "$RANGE_CODE" = 206
grep -qi '^accept-ranges: bytes' "$RANGE_HEADERS"
grep -qi '^content-range: bytes 0-99/' "$RANGE_HEADERS"

CONDITIONAL_RANGE_CODE="$(curl_status -H 'Range: bytes=0-99' -H "If-None-Match: $ETAG" "$FILE_URL")"
IF_RANGE_CODE="$(curl_status -H 'Range: bytes=0-99' -H "If-Range: $ETAG" "$FILE_URL")"
STALE_IF_RANGE_CODE="$(curl_status -H 'Range: bytes=0-99' -H 'If-Range: "stale"' "$FILE_URL")"
test "$CONDITIONAL_RANGE_CODE" = 304
test "$IF_RANGE_CODE" = 206
test "$STALE_IF_RANGE_CODE" = 200

sudo systemctl restart textbook-proofreading-api
sleep 1
CHAPTERS_AFTER_FILE="$TMP_ROOT/chapters-after.json"
WORKSPACE_A_AFTER_FILE="$TMP_ROOT/workspace-a-after.json"
WORKSPACE_B_AFTER_FILE="$TMP_ROOT/workspace-b-after.json"
CHAPTERS_AFTER_CODE="$(json_request "$CHAPTERS_AFTER_FILE" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters")"
WORKSPACE_A_AFTER_CODE="$(json_request "$WORKSPACE_A_AFTER_FILE" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_A_ID/proofreading")"
WORKSPACE_B_AFTER_CODE="$(json_request "$WORKSPACE_B_AFTER_FILE" "$BASE_URL/api/documents/$DOCUMENT_ID/chapters/$CHAPTER_B_ID/proofreading")"
test "$CHAPTERS_AFTER_CODE" = 200
test "$WORKSPACE_A_AFTER_CODE" = 200
test "$WORKSPACE_B_AFTER_CODE" = 200
test "$(json_value "$CHAPTERS_AFTER_FILE" 'x.chapters.length')" = 2
test "$(json_value "$WORKSPACE_A_AFTER_FILE" 'x.revision')" = 3
test "$(json_value "$WORKSPACE_B_AFTER_FILE" 'x.revision')" = 1
test "$(json_value "$WORKSPACE_A_AFTER_FILE" 'x.issues.length')" = 1
test "$(json_value "$WORKSPACE_B_AFTER_FILE" 'x.issues.length')" = 1

echo 'production-authenticated-root=pass'
echo 'production-authenticated-api=pass'
echo 'production-chunk-upload-and-inspection=pass'
echo 'production-chapter-a-b-persistence=pass'
echo 'production-cross-chapter-revision-independence=pass'
echo 'production-same-chapter-409=pass'
echo 'production-https-range-and-conditionals=pass'
echo 'production-restart-recovery=pass'
