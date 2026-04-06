#!/bin/bash
# repo-export.sh — Export all source files in this repo to a single readable text file
# Output lands one directory above the repo, named: {repo-name}_{YYYYMMDD_HHMM}.txt
# Usage: run from anywhere inside the repo (it will find the root via git)
# Add to Claude project knowledge to give Claude full repo context.

rm ../*.txt

set -euo pipefail

# ── Locate repo root ─────────────────────────────────────────────────────────
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "ERROR: Not inside a git repository." >&2
  exit 1
}

REPO_NAME=$(basename "$REPO_ROOT")
TIMESTAMP=$(date +"%Y%m%d_%H%M")
OUTPUT_FILE="${REPO_ROOT}/../${REPO_NAME}_${TIMESTAMP}.txt"
OUTPUT_FILE=$(realpath "$OUTPUT_FILE" 2>/dev/null || echo "$OUTPUT_FILE")

# ── File extensions to include ───────────────────────────────────────────────
INCLUDE_EXTENSIONS=(
  ts tsx js jsx
  json
  sql
  bicep
  md
  sh ps1
  css html
  yml yaml
  env gitignore
  txt
)

# ── Paths/patterns to exclude ────────────────────────────────────────────────
EXCLUDE_DIRS=(
  node_modules
  .git
  dist
  build
  .next
  .vite
  coverage
  __pycache__
  .turbo
)

# ── Build find arguments ──────────────────────────────────────────────────────
FIND_ARGS=()

# Exclude directories
for dir in "${EXCLUDE_DIRS[@]}"; do
  FIND_ARGS+=(-not -path "*/${dir}/*" -not -path "*/${dir}")
done

# Include only matching extensions
EXT_ARGS=()
for ext in "${INCLUDE_EXTENSIONS[@]}"; do
  EXT_ARGS+=(-o -name "*.${ext}")
done

# ── Write output ──────────────────────────────────────────────────────────────
{
  echo "================================================================"
  echo "REPO EXPORT: ${REPO_NAME}"
  echo "GENERATED:   $(date '+%Y-%m-%d %H:%M %Z')"
  echo "BRANCH:      $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
  echo "COMMIT:      $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
  echo "================================================================"
  echo ""

  # Print directory tree first (if tree is available)
  if command -v tree &>/dev/null; then
    echo "── DIRECTORY TREE ──────────────────────────────────────────────"
    tree -a -I "$(IFS='|'; echo "${EXCLUDE_DIRS[*]}")" "$REPO_ROOT"
    echo ""
  fi

  echo "── FILES ───────────────────────────────────────────────────────"
  echo ""

  # Find and sort all matching files
  find "$REPO_ROOT" \
    "${FIND_ARGS[@]}" \
    \( "${EXT_ARGS[@]:1}" \) \
    -type f \
    | sort \
    | while IFS= read -r filepath; do
        rel="${filepath#"$REPO_ROOT"/}"
        echo "================================================================"
        echo "FILE: ${rel}"
        echo "================================================================"
        cat "$filepath"
        echo ""
        echo ""
      done

} > "$OUTPUT_FILE"

LINES=$(wc -l < "$OUTPUT_FILE")
SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)

echo "✓ Export complete"
echo "  File:  $OUTPUT_FILE"
echo "  Lines: $LINES"
echo "  Size:  $SIZE"
echo ""
echo "Attach this file to your Claude project to give Claude full repo context."
