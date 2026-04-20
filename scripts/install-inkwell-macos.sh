#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="measure-one.inkwell"
EDITOR_CLI="auto"
TEX_DIST="mactex"

for arg in "$@"; do
  case "$arg" in
    --editor=cursor) EDITOR_CLI="cursor" ;;
    --editor=code) EDITOR_CLI="code" ;;
    --editor=auto) EDITOR_CLI="auto" ;;
    --basictex) TEX_DIST="basictex" ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--editor=auto|cursor|code] [--basictex]"
      exit 1
      ;;
  esac
done

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only."
  echo "For Linux setup, follow README instructions."
  exit 1
fi

if ! has_cmd brew; then
  echo "Homebrew is required. Install it first from https://brew.sh"
  exit 1
fi

if ! has_cmd npm; then
  echo "npm is required for Mermaid CLI. Install Node.js first."
  exit 1
fi

if [[ "$EDITOR_CLI" == "auto" ]]; then
  if has_cmd cursor; then
    EDITOR_CLI="cursor"
  elif has_cmd code; then
    EDITOR_CLI="code"
  else
    EDITOR_CLI=""
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BREWFILE="$REPO_ROOT/Brewfile"

if [[ -f "$BREWFILE" ]] && [[ "$TEX_DIST" == "mactex" ]]; then
  echo "Installing toolchain and extension via brew bundle..."
  brew bundle --file="$BREWFILE"
else
  echo "Installing toolchain with Homebrew..."
  brew install pandoc pandoc-crossref
  if [[ "$TEX_DIST" == "basictex" ]]; then
    brew install --cask basictex
  else
    brew install --cask mactex
  fi

  if [[ -n "$EDITOR_CLI" ]]; then
    echo "Installing extension from marketplace with $EDITOR_CLI..."
    "$EDITOR_CLI" --install-extension "$EXTENSION_ID" --force
  else
    echo "Could not find cursor or code CLI."
    echo "Install extension manually from the extension marketplace:"
    echo "  $EXTENSION_ID"
  fi
fi

echo "Installing Mermaid CLI..."
npm install -g @mermaid-js/mermaid-cli

export PATH="/Library/TeX/texbin:$HOME/Library/TinyTeX/bin/universal-darwin:$PATH"

REQ_FILE=""
if [[ -f "./requirements-latex.txt" ]]; then
  REQ_FILE="./requirements-latex.txt"
elif [[ -f "$(cd "$(dirname "$0")/.." && pwd)/requirements-latex.txt" ]]; then
  REQ_FILE="$(cd "$(dirname "$0")/.." && pwd)/requirements-latex.txt"
fi

if has_cmd tlmgr && [[ -n "$REQ_FILE" ]]; then
  echo "Installing LaTeX requirements from $REQ_FILE..."
  tlmgr update --self
  sed 's/#.*//' "$REQ_FILE" | awk 'NF' | xargs tlmgr install
  texhash || mktexlsr
else
  echo "Skipping tlmgr package pass (tlmgr or requirements file not found)."
fi

# Ownership check. A curl | sudo sh bootstrap of TinyTeX (or an aborted
# BasicTeX install that left an intermediate root-owned state) leaves
# the TeX tree owned by root. Subsequent tlmgr installs succeed as
# root but the ls-R index update fails silently when the user later
# tries to compile, producing the "File 'xstring.sty' not found" class
# of errors even though the file sits right there on disk. Detect that
# state now and offer a one-line remediation before the user ever
# hits it from the extension.
if has_cmd kpsewhich; then
  TEX_ROOT="$(kpsewhich -var-value TEXMFROOT 2>/dev/null || true)"
  if [[ -n "$TEX_ROOT" && -d "$TEX_ROOT" ]]; then
    TEX_OWNER="$(stat -f '%Su' "$TEX_ROOT" 2>/dev/null || true)"
    if [[ -n "$TEX_OWNER" && "$TEX_OWNER" != "$USER" ]]; then
      echo ""
      echo "WARNING: TEXMFROOT ($TEX_ROOT) is owned by '$TEX_OWNER' but you are '$USER'."
      echo "This breaks 'tlmgr install' silently: packages install but never register in the file index."
      echo "Run this to fix:"
      echo "    sudo chown -R \"$USER\" \"$TEX_ROOT\" && \"$TEX_ROOT/bin/universal-darwin/texhash\""
      echo ""
    fi
  fi
fi

echo ""
echo "Inkwell setup complete."
echo "Next steps:"
echo "1) Reload Cursor/VS Code."
echo "2) Open Command Palette and run: Inkwell: Check / Install Toolchain"
echo "3) Open a markdown file and test shortcuts:"
echo "   Cmd+Shift+V (preview), Cmd+Shift+R (compile), Cmd+Alt+R (run code blocks)"
