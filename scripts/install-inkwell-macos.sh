#!/usr/bin/env bash
set -euo pipefail

# Bootstrap the authoritative release VSIX. All installation, exact-editor
# verification and full health checks live in that versioned artifact.
INKWELL_RELEASE_VERSION="0.5.0"
INKWELL_EDITOR="auto"
INKWELL_PROFILE="full"
INKWELL_VSIX=""
INKWELL_EXPECTED_SHA=""
INKWELL_OUTPUT=""
INKWELL_UNINSTALL=0

usage() {
  echo "Usage: $0 [--editor=auto|all|cursor|code] [--profile=full|lean] [--version=X.Y.Z] [--vsix=/path/to/release.vsix] [--sha256=HASH] [--output-root=/path]"
}
for arg in "$@"; do
  case "$arg" in
    --editor=auto|--editor=all|--editor=cursor|--editor=code) INKWELL_EDITOR="${arg#*=}" ;;
    --profile=full|--profile=lean) INKWELL_PROFILE="${arg#*=}" ;;
    --basictex) INKWELL_PROFILE="lean" ;;
    --version=*) INKWELL_RELEASE_VERSION="${arg#*=}" ;;
    --vsix=*) INKWELL_VSIX="${arg#*=}" ;;
    --sha256=*) INKWELL_EXPECTED_SHA="${arg#*=}" ;;
    --output-root=*) INKWELL_OUTPUT="${arg#*=}" ;;
    --uninstall) INKWELL_UNINSTALL=1 ;;
    --yes) ;; # Running this installer explicitly authorizes its displayed plan.
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ ! "$INKWELL_RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "Invalid release version." >&2; exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS. Use the headless doctor or Setup / Repair in your editor on other platforms." >&2; exit 1
fi
INKWELL_BREW="$(command -v brew || true)"
if [[ -z "$INKWELL_BREW" ]]; then
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then INKWELL_BREW="$candidate"; break; fi
  done
fi
if [[ -z "$INKWELL_BREW" ]]; then
  echo "Homebrew is required. Install it from https://brew.sh, then repeat this command." >&2; exit 1
fi
INKWELL_NODE="$(command -v node || true)"
if [[ -z "$INKWELL_NODE" ]]; then
  "$INKWELL_BREW" install node
  INKWELL_BREW_PREFIX="$("$INKWELL_BREW" --prefix)"
  INKWELL_NODE="$INKWELL_BREW_PREFIX/bin/node"
fi
if [[ ! -x "$INKWELL_NODE" ]]; then echo "Node runtime installation could not be verified." >&2; exit 1; fi
"$INKWELL_NODE" --version >/dev/null
INKWELL_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/inkwell-install.XXXXXX")"
trap 'rm -rf "$INKWELL_TEMP"' EXIT
if [[ -z "$INKWELL_VSIX" ]]; then
  INKWELL_BASE="https://github.com/goldberg-consulting/measured.one.inkwell-extension/releases/download/v$INKWELL_RELEASE_VERSION"
  INKWELL_VSIX="$INKWELL_TEMP/inkwell-$INKWELL_RELEASE_VERSION.vsix"
  curl --fail --location --proto '=https' --tlsv1.2 "$INKWELL_BASE/inkwell-$INKWELL_RELEASE_VERSION.vsix" --output "$INKWELL_VSIX"
  if [[ -z "$INKWELL_EXPECTED_SHA" ]]; then
    curl --fail --location --proto '=https' --tlsv1.2 "$INKWELL_BASE/SHA256SUMS" --output "$INKWELL_TEMP/SHA256SUMS"
    INKWELL_EXPECTED_SHA="$(awk -v name="inkwell-$INKWELL_RELEASE_VERSION.vsix" '$2 == name {print $1}' "$INKWELL_TEMP/SHA256SUMS")"
  fi
  if [[ ! "$INKWELL_EXPECTED_SHA" =~ ^[a-fA-F0-9]{64}$ ]]; then echo "The release checksum does not identify this VSIX." >&2; exit 1; fi
fi
if [[ ! -f "$INKWELL_VSIX" ]]; then echo "The release VSIX does not exist: $INKWELL_VSIX" >&2; exit 1; fi
INKWELL_VSIX="$(cd "$(dirname "$INKWELL_VSIX")" && pwd)/$(basename "$INKWELL_VSIX")"
if [[ -n "$INKWELL_EXPECTED_SHA" ]]; then
  if [[ ! "$INKWELL_EXPECTED_SHA" =~ ^[a-fA-F0-9]{64}$ ]]; then echo "Release checksum is missing or malformed." >&2; exit 1; fi
  INKWELL_ACTUAL_SHA="$(shasum -a 256 "$INKWELL_VSIX" | awk '{print $1}')"
  if [[ "$INKWELL_ACTUAL_SHA" != "$INKWELL_EXPECTED_SHA" ]]; then echo "Release VSIX checksum verification failed." >&2; exit 1; fi
fi
unzip -q "$INKWELL_VSIX" -d "$INKWELL_TEMP/payload"
INKWELL_ARTIFACT="$INKWELL_TEMP/payload/extension"
if [[ ! -f "$INKWELL_ARTIFACT/out/install-cli.js" ]]; then
  echo "This VSIX does not contain the verified Inkwell installer. Download a 0.5 release artifact." >&2; exit 1
fi
INKWELL_ARGS=("--artifact-root=$INKWELL_ARTIFACT" "--vsix=$INKWELL_VSIX" "--version=$INKWELL_RELEASE_VERSION" "--editor=$INKWELL_EDITOR" "--profile=$INKWELL_PROFILE" "--yes")
if [[ -n "$INKWELL_OUTPUT" ]]; then INKWELL_ARGS+=("--output-root=$INKWELL_OUTPUT"); fi
if [[ "$INKWELL_UNINSTALL" == 1 ]]; then INKWELL_ARGS+=("--uninstall"); fi
"$INKWELL_NODE" "$INKWELL_ARTIFACT/out/install-cli.js" "${INKWELL_ARGS[@]}"
