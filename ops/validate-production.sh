#!/usr/bin/env bash
set -Eeuo pipefail

if (( EUID != 0 )); then
  exec sudo -- "$0" "$@"
fi

umask 077

BASE_URL="${BASE_URL:-https://proofreading.example.com}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
AUTH_ENV_FILE="${AUTH_ENV_FILE:-/etc/legal-textbook-proofreading-workbench/auth.env}"
TMP_ROOT="$(mktemp -d -t textbook-production-smoke-XXXXXX)"
LOGIN_BODY="$TMP_ROOT/login.json"
LOGIN_HEADERS="$TMP_ROOT/login.headers"
COOKIE_JAR="$TMP_ROOT/cookies"
DOCUMENT_ID=""

cleanup() {
  set +e
  if [[ -n "$DOCUMENT_ID" && -f "$LOGIN_BODY" ]]; then
    for _ in {1..30}; do
      : > "$COOKIE_JAR"
      login_code="$(curl --max-time 45 -sS -o /dev/null -w '%{http_code}' \
        -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
        -X POST -H 'content-type: application/json' --data-binary "@$LOGIN_BODY" \
        "$BASE_URL/api/auth/login" 2>/dev/null)"
      if [[ "$login_code" = 200 ]]; then
        delete_code="$(curl --max-time 45 -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" \
          -X DELETE "$BASE_URL/api/documents/$DOCUMENT_ID" 2>/dev/null)"
        [[ "$delete_code" = 204 || "$delete_code" = 404 ]] && break
      fi
      sleep 1
    done
  fi
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

"$NODE_BIN" -e '
const fs = require("node:fs")
const input = process.argv[1]
const output = process.argv[2]
const text = fs.readFileSync(input, "utf8")
const values = new Map()
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim()
  if (!line || line.startsWith("#")) continue
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(rawLine)
  if (!match || values.has(match[1])) throw new Error("invalid auth environment format")
  if (!["WORKBENCH_ACCESS_USERNAME", "WORKBENCH_ACCESS_PASSWORD"].includes(match[1])) {
    throw new Error("unexpected auth environment key")
  }
  values.set(match[1], match[2])
}
const username = values.get("WORKBENCH_ACCESS_USERNAME")
const password = values.get("WORKBENCH_ACCESS_PASSWORD")
if (typeof username !== "string" || !username.trim() || username !== "proofreader") {
  throw new Error("invalid workbench username configuration")
}
if (typeof password !== "string" || !password.trim()) {
  throw new Error("invalid workbench password configuration")
}
fs.writeFileSync(output, JSON.stringify({ username, password }), { mode: 0o600 })
' "$AUTH_ENV_FILE" "$LOGIN_BODY"

: > "$COOKIE_JAR"

curl_status() {
  curl --max-time 45 -sS -o /dev/null -w '%{http_code}' "$@"
}

auth_curl_status() {
  curl --max-time 45 -sS -o /dev/null -w '%{http_code}' \
    -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$@"
}

json_value() {
  local file="$1"
  local expression="$2"
  "$NODE_BIN" -e "const fs=require('node:fs'); const x=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(${expression})" "$file"
}

json_request() {
  local output="$1"
  shift
  curl --max-time 45 -sS -o "$output" -w '%{http_code}' \
    -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$@"
}

public_json_request() {
  local output="$1"
  shift
  curl --max-time 45 -sS -o "$output" -w '%{http_code}' "$@"
}

login() {
  : > "$COOKIE_JAR"
  curl --max-time 45 -sS -o "$TMP_ROOT/login-response.json" -D "$LOGIN_HEADERS" \
    -w '%{http_code}' -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -X POST -H 'content-type: application/json' --data-binary "@$LOGIN_BODY" \
    "$BASE_URL/api/auth/login"
}

test "$(curl_status "$BASE_URL/")" = 200
test "$(curl_status "$BASE_URL/login")" = 200

UNAUTH_SESSION_FILE="$TMP_ROOT/unauth-session.json"
UNAUTH_SESSION_CODE="$(public_json_request "$UNAUTH_SESSION_FILE" "$BASE_URL/api/auth/session")"
test "$UNAUTH_SESSION_CODE" = 200
test "$(json_value "$UNAUTH_SESSION_FILE" 'x.authenticated')" = false

UNAUTH_DOCUMENTS_FILE="$TMP_ROOT/unauth-documents.json"
UNAUTH_DOCUMENTS_CODE="$(public_json_request "$UNAUTH_DOCUMENTS_FILE" "$BASE_URL/api/documents")"
test "$UNAUTH_DOCUMENTS_CODE" = 401
test "$(json_value "$UNAUTH_DOCUMENTS_FILE" 'x.error')" = authentication_required

LOGIN_CODE="$(login)"
test "$LOGIN_CODE" = 200
test "$(json_value "$TMP_ROOT/login-response.json" 'x.authenticated')" = true
test "$(json_value "$TMP_ROOT/login-response.json" 'x.account.username')" = proofreader
grep -qi '^set-cookie: proofread_session=' "$LOGIN_HEADERS"
grep -qi '^set-cookie: .*; HttpOnly' "$LOGIN_HEADERS"
grep -qi '^set-cookie: .*; Secure' "$LOGIN_HEADERS"
grep -qi '^set-cookie: .*; SameSite=Lax' "$LOGIN_HEADERS"

AUTH_SESSION_FILE="$TMP_ROOT/auth-session.json"
AUTH_SESSION_CODE="$(json_request "$AUTH_SESSION_FILE" "$BASE_URL/api/auth/session")"
test "$AUTH_SESSION_CODE" = 200
test "$(json_value "$AUTH_SESSION_FILE" 'x.authenticated')" = true

AUTH_DOCUMENTS_FILE="$TMP_ROOT/auth-documents.json"
AUTH_DOCUMENTS_CODE="$(json_request "$AUTH_DOCUMENTS_FILE" "$BASE_URL/api/documents")"
test "$AUTH_DOCUMENTS_CODE" = 200

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
  PART_CODE="$(auth_curl_status -X PUT -H 'content-type: application/octet-stream' --data-binary "@$PART_FILE" "$BASE_URL/api/uploads/$UPLOAD_ID/parts/$part")"
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
FULL_CODE="$(auth_curl_status -D "$FILE_HEADERS" "$FILE_URL")"
HEAD_CODE="$(auth_curl_status -I "$FILE_URL")"
ETAG="$(awk 'tolower($1) == "etag:" { gsub("\r", "", $2); print $2 }' "$FILE_HEADERS")"
LAST_MODIFIED="$(awk 'tolower($1) == "last-modified:" { $1=""; sub(/^ /, ""); gsub("\r", ""); print }' "$FILE_HEADERS")"
test "$FULL_CODE" = 200
test "$HEAD_CODE" = 200
test -n "$ETAG"
test -n "$LAST_MODIFIED"

RANGE_CODE="$(auth_curl_status -D "$RANGE_HEADERS" -H 'Range: bytes=0-99' "$FILE_URL")"
test "$RANGE_CODE" = 206
grep -qi '^accept-ranges: bytes' "$RANGE_HEADERS"
grep -qi '^content-range: bytes 0-99/' "$RANGE_HEADERS"

CONDITIONAL_RANGE_CODE="$(auth_curl_status -H 'Range: bytes=0-99' -H "If-None-Match: $ETAG" "$FILE_URL")"
IF_RANGE_CODE="$(auth_curl_status -H 'Range: bytes=0-99' -H "If-Range: $ETAG" "$FILE_URL")"
STALE_IF_RANGE_CODE="$(auth_curl_status -H 'Range: bytes=0-99' -H 'If-Range: "stale"' "$FILE_URL")"
test "$CONDITIONAL_RANGE_CODE" = 304
test "$IF_RANGE_CODE" = 206
test "$STALE_IF_RANGE_CODE" = 200

# Restart recovery remains part of the original production validation. The
# in-memory session must be replaced after the restart before reading data.
OLD_MAIN_PID="$(systemctl show -p MainPID --value textbook-proofreading-api.service)"
systemctl restart textbook-proofreading-api.service
for _ in {1..30}; do
  [[ "$(systemctl is-active textbook-proofreading-api.service)" = active ]] && break
  sleep 1
done
test "$(systemctl is-active textbook-proofreading-api.service)" = active
NEW_MAIN_PID="$(systemctl show -p MainPID --value textbook-proofreading-api.service)"
test -n "$NEW_MAIN_PID"
test "$NEW_MAIN_PID" != "$OLD_MAIN_PID"

# systemd can report active before Node has bound the loopback socket. Wait for
# the public session endpoint before asserting post-restart authentication.
for _ in {1..30}; do
  READY_CODE="$(curl_status "$BASE_URL/api/auth/session" 2>/dev/null || true)"
  [[ "$READY_CODE" = 200 ]] && break
  sleep 1
done
test "$(curl_status "$BASE_URL/api/auth/session")" = 200
test "$(auth_curl_status "$BASE_URL/api/documents")" = 401
test "$(login)" = 200

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

DELETE_CODE="$(auth_curl_status -X DELETE "$BASE_URL/api/documents/$DOCUMENT_ID")"
test "$DELETE_CODE" = 204
DOCUMENT_ID=""

LOGOUT_CODE="$(auth_curl_status -X POST "$BASE_URL/api/auth/logout")"
test "$LOGOUT_CODE" = 204
test "$(auth_curl_status "$BASE_URL/api/documents")" = 401

AFTER_LOGOUT_SESSION_FILE="$TMP_ROOT/after-logout-session.json"
AFTER_LOGOUT_SESSION_CODE="$(json_request "$AFTER_LOGOUT_SESSION_FILE" "$BASE_URL/api/auth/session")"
test "$AFTER_LOGOUT_SESSION_CODE" = 200
test "$(json_value "$AFTER_LOGOUT_SESSION_FILE" 'x.authenticated')" = false

echo 'production-public-static-spa=pass'
echo 'production-unauthenticated-api-401=pass'
echo 'production-application-login-session=pass'
echo 'production-session-cookie-flags=pass'
echo 'production-authenticated-api=pass'
echo 'production-chunk-upload-and-inspection=pass'
echo 'production-chapter-a-b-persistence=pass'
echo 'production-cross-chapter-revision-independence=pass'
echo 'production-same-chapter-409=pass'
echo 'production-https-range-and-conditionals=pass'
echo 'production-restart-recovery-and-relogin=pass'
echo 'production-logout-and-old-cookie-401=pass'
echo 'production-synthetic-document-cleanup=pass'
