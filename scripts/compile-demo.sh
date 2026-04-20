#!/usr/bin/env bash
# Compile a single demo Markdown file the same way the Inkwell
# extension's compile pipeline does:
#
#   1. pandoc -> .tex  (template + pandoc-crossref filter + --citeproc)
#   2. engine -> .pdf, twice (resolves \ref / \pageref / crossref)
#   3. (only when the generated .tex uses \bibliography / \addbibresource)
#      biber/bibtex + one more engine pass
#
# Used by scripts/compile-all-demos.sh and .github/workflows/compile-demos.yml
# for CI regression testing, and by developers who need to reproduce
# an extension compile failure from the shell without reading the
# minified bundle.
#
# Usage:
#   scripts/compile-demo.sh examples/demo-rho.md
#   scripts/compile-demo.sh examples/demo-rho.md --keep-work  # preserve work dir
#
# Exit codes:
#   0  compile succeeded, PDF produced
#   1  pandoc failed
#   2  engine failed to produce a PDF
#   3  argument error

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <input.md> [--keep-work]" >&2
  exit 3
fi

SRC="$1"
KEEP_WORK="no"
for arg in "${@:2}"; do
  case "$arg" in
    --keep-work) KEEP_WORK="yes" ;;
    *) echo "Unknown flag: $arg" >&2; exit 3 ;;
  esac
done

if [[ ! -f "$SRC" ]]; then
  echo "File not found: $SRC" >&2
  exit 3
fi

SRC_DIR="$(cd "$(dirname "$SRC")" && pwd)"
SRC_BASE="$(basename "$SRC")"
SRC_STEM="${SRC_BASE%.md}"
SRC_ABS="$SRC_DIR/$SRC_BASE"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Discover the template from the frontmatter ───────────────────────
# We read the YAML frontmatter manually so we do not need a YAML parser
# in CI; only 'template:' is required. Match is case-sensitive and
# tolerates quotes around the value.
TEMPLATE="$(awk '
  /^---$/ { fm = !fm; next }
  fm && $1 == "template:" {
    v = $2
    gsub(/^[\"\x27]/, "", v)
    gsub(/[\"\x27]$/, "", v)
    print v
    exit
  }
' "$SRC_ABS")"

if [[ -z "$TEMPLATE" ]]; then
  TEMPLATE="inkwell"
fi

TEMPLATE_DIR="$REPO_ROOT/templates/$TEMPLATE"
TEMPLATE_LATEX="$TEMPLATE_DIR/$TEMPLATE.latex"
if [[ "$TEMPLATE" == "inkwell" ]]; then
  TEMPLATE_LATEX="$REPO_ROOT/templates/inkwell.latex"
  TEMPLATE_DIR="$REPO_ROOT/templates"
fi

if [[ ! -f "$TEMPLATE_LATEX" ]]; then
  echo "Template not found: $TEMPLATE_LATEX" >&2
  exit 3
fi

# Resolve engine from the template's template.json.
ENGINE="xelatex"
if [[ -f "$TEMPLATE_DIR/template.json" ]]; then
  ENGINE_FROM_JSON="$(awk -F'"' '/"engine"/ { print $4; exit }' "$TEMPLATE_DIR/template.json" || true)"
  if [[ -n "$ENGINE_FROM_JSON" ]]; then
    ENGINE="$ENGINE_FROM_JSON"
  fi
fi

if ! command -v "$ENGINE" >/dev/null 2>&1; then
  echo "Engine '$ENGINE' not on PATH" >&2
  exit 3
fi

# ── Set up the work directory ────────────────────────────────────────
WORK="$(mktemp -d -t inkwell-compile-XXXXXX)"
cleanup() {
  if [[ "$KEEP_WORK" == "no" ]]; then
    rm -rf "$WORK"
  else
    echo "(work dir preserved at $WORK)" >&2
  fi
}
trap cleanup EXIT

cp "$SRC_ABS" "$WORK/"
cp "$TEMPLATE_LATEX" "$WORK/"
TEMPLATE_NAME="$(basename "$TEMPLATE_LATEX")"

# Copy supporting files from the template dir (cls, sty, bst, figures,
# logos). The real extension does this via copySupportingFiles; here
# we match the behaviour by copying every non-README file.
shopt -s nullglob
for entry in "$TEMPLATE_DIR"/*; do
  base="$(basename "$entry")"
  case "$base" in
    README.md|template.json|main.tex|sample_paper.tex) continue ;;
  esac
  cp -R "$entry" "$WORK/"
done
shopt -u nullglob

# Copy bibliography files from the project's .inkwell/references/.
mkdir -p "$WORK/.inkwell/references"
if [[ -d "$REPO_ROOT/.inkwell/references" ]]; then
  cp -R "$REPO_ROOT/.inkwell/references/." "$WORK/.inkwell/references/"
fi

# Pandoc extensions that the extension enables.
PANDOC_EXTS="raw_tex+raw_attribute+tex_math_dollars+citations+footnotes+yaml_metadata_block+implicit_figures+link_attributes+fenced_divs+bracketed_spans+pipe_tables+smart"

CROSSREF_BIN=""
if command -v pandoc-crossref >/dev/null 2>&1; then
  CROSSREF_BIN="$(command -v pandoc-crossref)"
fi

# Build pandoc args.
PANDOC_ARGS=(
  "$WORK/$SRC_BASE"
  -o "$WORK/$SRC_STEM.tex"
  --standalone
  --template="$WORK/$TEMPLATE_NAME"
  --from="markdown+$PANDOC_EXTS"
  --resource-path="$WORK:$TEMPLATE_DIR:$SRC_DIR:$REPO_ROOT"
  -V graphics=true
  -V colorlinks=true
  -V numbersections=true
)

if [[ -n "$CROSSREF_BIN" ]]; then
  PANDOC_ARGS+=(--filter "$CROSSREF_BIN")
fi
PANDOC_ARGS+=(--citeproc)

# Add all bib files from the project.
shopt -s nullglob
for bib in "$REPO_ROOT"/*.bib "$REPO_ROOT/references/"*.bib "$REPO_ROOT/.inkwell/references/"*.bib; do
  if [[ -f "$bib" ]]; then
    PANDOC_ARGS+=(--bibliography "$bib")
  fi
done
shopt -u nullglob

echo "[compile-demo] template=$TEMPLATE engine=$ENGINE"
echo "[compile-demo] pandoc argv:"
printf '  %q' pandoc "${PANDOC_ARGS[@]}"
echo

if ! pandoc "${PANDOC_ARGS[@]}"; then
  echo "[compile-demo] pandoc failed" >&2
  exit 1
fi

if [[ ! -f "$WORK/$SRC_STEM.tex" ]]; then
  echo "[compile-demo] pandoc did not produce a .tex" >&2
  exit 1
fi

export TEXINPUTS="$WORK:$TEMPLATE_DIR:$SRC_DIR:$REPO_ROOT:$REPO_ROOT/.inkwell:"

ENGINE_ARGS=(
  -interaction=nonstopmode
  -halt-on-error
  "-output-directory=$WORK"
  "$WORK/$SRC_STEM.tex"
)

echo "[compile-demo] $ENGINE pass 1"
"$ENGINE" "${ENGINE_ARGS[@]}" || true
echo "[compile-demo] $ENGINE pass 2"
"$ENGINE" "${ENGINE_ARGS[@]}" || true

# Raw \cite path: run biber/bibtex if the generated .tex uses them.
if grep -qE '\\(bibliography|addbibresource)\{' "$WORK/$SRC_STEM.tex"; then
  if command -v biber >/dev/null 2>&1; then
    echo "[compile-demo] biber"
    (cd "$WORK" && biber "$SRC_STEM") || true
  elif command -v bibtex >/dev/null 2>&1; then
    echo "[compile-demo] bibtex"
    (cd "$WORK" && bibtex "$SRC_STEM") || true
  fi
  echo "[compile-demo] $ENGINE pass 3 (post-bib)"
  "$ENGINE" "${ENGINE_ARGS[@]}" || true
fi

if [[ ! -f "$WORK/$SRC_STEM.pdf" ]]; then
  echo "[compile-demo] engine did not produce a PDF" >&2
  tail -60 "$WORK/$SRC_STEM.log" 2>/dev/null | sed 's/^/    /' >&2 || true
  exit 2
fi

OUT_PDF="$SRC_DIR/$SRC_STEM.pdf"
cp "$WORK/$SRC_STEM.pdf" "$OUT_PDF"
echo "[compile-demo] OK: $OUT_PDF"
