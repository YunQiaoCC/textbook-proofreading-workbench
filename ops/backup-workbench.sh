#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

PROJECT_ROOT="${PROJECT_ROOT:-/home/ubuntu/textbook-proofreading-workbench}"
STORAGE_ROOT="${STORAGE_ROOT:-$PROJECT_ROOT/storage}"
BACKUP_ROOT="${BACKUP_ROOT:-/home/ubuntu/textbook-proofreading-backups}"
RETENTION_COUNT="${RETENTION_COUNT:-7}"

if ! [[ "$RETENTION_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  printf 'RETENTION_COUNT must be a positive integer\n' >&2
  exit 2
fi

for required_dir in "$STORAGE_ROOT/documents" "$STORAGE_ROOT/metadata"; do
  if [[ ! -d "$required_dir" ]]; then
    printf 'required storage directory is missing: %s\n' "$required_dir" >&2
    exit 1
  fi
done

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_ROOT/textbook-proofreading-${timestamp}.tar.gz"
tmp_archive="${archive}.tmp.$$"
sha_file="${archive}.sha256"
tmp_sha_file="${sha_file}.tmp.$$"
manifest="${archive}.manifest"
tmp_manifest="${manifest}.tmp.$$"

cleanup() {
  rm -f -- "$tmp_archive" "$tmp_sha_file" "$tmp_manifest"
}
trap cleanup EXIT

git_commit="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"

# Deliberately archive only durable business data. storage/temp contains
# resumable upload sessions and is not part of the restore boundary.
tar -czf "$tmp_archive" -C "$STORAGE_ROOT" documents metadata
chmod 600 "$tmp_archive"
mv -f -- "$tmp_archive" "$archive"

archive_sha256="$(sha256sum "$archive" | awk '{print $1}')"
printf '%s  %s\n' "$archive_sha256" "$(basename "$archive")" > "$tmp_sha_file"
chmod 600 "$tmp_sha_file"
mv -f -- "$tmp_sha_file" "$sha_file"

{
  printf 'timestamp=%s\n' "$timestamp"
  printf 'git_commit=%s\n' "$git_commit"
  printf 'archive=%s\n' "$(basename "$archive")"
  printf 'archive_sha256=%s\n' "$archive_sha256"
  printf 'scope=storage/documents storage/metadata\n'
} > "$tmp_manifest"
chmod 600 "$tmp_manifest"
mv -f -- "$tmp_manifest" "$manifest"

# Prune only after the new archive, checksum, and manifest have all been
# written successfully. Every deletion is constrained to this backup root.
while IFS= read -r old_archive; do
  [[ -z "$old_archive" ]] && continue
  case "$old_archive" in
    "$BACKUP_ROOT"/textbook-proofreading-*.tar.gz)
      rm -f -- "$old_archive" "${old_archive}.sha256" "${old_archive}.manifest"
      ;;
    *)
      printf 'refusing to prune unexpected path: %s\n' "$old_archive" >&2
      exit 1
      ;;
  esac
done < <(
  find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'textbook-proofreading-*.tar.gz' -printf '%T@ %p\n' |
    sort -nr |
    tail -n +$((RETENTION_COUNT + 1)) |
    cut -d' ' -f2-
)

printf 'backup=pass archive=%s\n' "$(basename "$archive")"
