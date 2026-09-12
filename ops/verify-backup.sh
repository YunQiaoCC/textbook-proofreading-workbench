#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/textbook-proofreading-backups}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [[ $# -gt 1 ]]; then
  printf 'usage: %s [archive.tar.gz]\n' "$0" >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  archive="$1"
else
  archive="$(find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'textbook-proofreading-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi

if [[ -z "$archive" || ! -f "$archive" ]]; then
  printf 'no backup archive found\n' >&2
  exit 1
fi

case "$archive" in
  "$BACKUP_ROOT"/textbook-proofreading-*.tar.gz) ;;
  *)
    printf 'archive must be under the configured backup root\n' >&2
    exit 2
    ;;
esac

sha_file="${archive}.sha256"
manifest="${archive}.manifest"
[[ -f "$sha_file" ]] || { printf 'checksum sidecar is missing\n' >&2; exit 1; }
[[ -f "$manifest" ]] || { printf 'manifest is missing\n' >&2; exit 1; }

archive_sha256="$(sha256sum "$archive" | awk '{print $1}')"
(cd "$BACKUP_ROOT" && sha256sum --check --status "$sha_file")
grep -Fq 'timestamp=' "$manifest"
grep -Fq 'git_commit=' "$manifest"
grep -Fq "archive_sha256=$archive_sha256" "$manifest"

restore_root="$(mktemp -d -t textbook-proofreading-restore-XXXXXX)"
cleanup() {
  rm -rf -- "$restore_root"
}
trap cleanup EXIT

tar -xzf "$archive" -C "$restore_root"
[[ -d "$restore_root/documents" ]] || { printf 'documents directory is missing\n' >&2; exit 1; }
[[ -d "$restore_root/metadata" ]] || { printf 'metadata directory is missing\n' >&2; exit 1; }

while IFS= read -r -d '' metadata_file; do
  "$NODE_BIN" -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$metadata_file"
done < <(find "$restore_root/metadata" -type f -name '*.json' -print0)

printf 'backup-verify=pass archive=%s\n' "$(basename "$archive")"
