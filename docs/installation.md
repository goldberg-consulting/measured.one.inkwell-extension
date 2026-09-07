# Installation and health checks

## 0.5 release status

These instructions describe the 0.5 implementation under validation. The matching
release VSIX and Homebrew checksum have not been published yet. A current tap
installation may still install the preceding release. Passing an artifact audit
or mocked lifecycle test does not establish that installation on a clean Mac has
passed. The release checks below must be recorded before claiming that result.

## One-command macOS installation

With Homebrew and Cursor or VS Code already installed, the 0.5 release cask uses:

```bash
brew install --cask goldberg-consulting/inkwell/inkwell
```

The cask retains the downloaded VSIX in its versioned Caskroom directory and runs
the installer bundled inside that artifact. It detects supported editors on PATH,
in Homebrew locations, and inside their application bundles in `/Applications`
or `~/Applications`. It verifies the exact `measure-one.inkwell` release in every
selected editor. No editor shell-command setup is needed.

Homebrew manages Pandoc, pandoc-crossref, Mermaid CLI, and Node. A working existing
TeX distribution is reused. If TeX is absent, the default profile installs full
MacTeX. The installer uses the requirements file inside the VSIX payload and
installs only missing packages. It does not use a same-named file in the caller's
working directory.

Completion requires successful editor version verification, the full health
report, and an actual Inkwell PDF build. Failed or interrupted work retains
diagnostics and does not print a successful completion message. The installer
retains its verification project, PDFs, state, and logs under
`~/Library/Application Support/Inkwell/verification/0.5.0`.

Reload an already-running editor after installation or upgrade. Upgrades use
`brew upgrade --cask goldberg-consulting/inkwell/inkwell`. If Homebrew asks you to
trust the tap, follow its prompt. Never bypass a release checksum failure.

## Editor selection and an existing VSIX

From a checkout of the matching release, use the versioned bootstrap for explicit
selection:

```bash
./scripts/install-inkwell-macos.sh --editor=cursor
./scripts/install-inkwell-macos.sh --editor=code
./scripts/install-inkwell-macos.sh --editor=all
```

`auto` is the default; both `auto` and `all` select every detected supported
editor. `cursor` and `code` narrow selection. No matching editor, a failed editor
process, or a mismatched installed extension version makes setup unsuccessful.

The bootstrap downloads the versioned release VSIX and its published checksum.
To use an existing artifact, supply its absolute path and expected version:

```bash
./scripts/install-inkwell-macos.sh \
  --vsix=/absolute/path/inkwell-0.5.0.vsix \
  --version=0.5.0 --editor=cursor
```

For a downloaded local file, add `--sha256=` with the checksum from the release
to verify the archive before extraction. The packaged installer also checks the
payload identity, version, and asset manifest. The bootstrap is an installation
command that authorizes its displayed plan; use **Inkwell: Setup / Repair** in the
editor when you want to review proposed system changes before approving them.

You can also choose **Extensions: Install from VSIX...** in an editor, select the
release file, reload, and run **Inkwell: Setup / Repair**. The 0.5 release artifact
is the authoritative distribution; the Brewfile does not install a potentially
different marketplace version.

## TeX profiles and ownership

The full profile supplies MacTeX when no functioning distribution exists. The
explicit lean profile selects BasicTeX in that situation:

```bash
./scripts/install-inkwell-macos.sh --profile=lean
```

Lean setup can require many additional fonts and template packages and must pass
the same exact-file and PDF checks as the full profile. A working user TinyTeX
installation is also reused; it is not replaced by BasicTeX or MacTeX.

User-owned TinyTeX uses its own package manager without sudo. Root ownership is
normal for a system MacTeX installation, whose package manager may require
administrator permission. Inkwell preserves that ownership. An incorrectly
owned or unwritable user installation is reported for distribution-specific
repair; recursively changing ownership is not an Inkwell repair action.

## Setup / Repair in the editor

The command, first-run walkthrough, New Project, and explicit workspace setup
share one tracked workflow:

1. Inspect current capabilities and prepare a plan.
2. Obtain consent for proposed system changes.
3. Observe each installation process and its exit status.
4. Probe the installed capabilities again.
5. Create or migrate the project scaffold, preserving edited files.
6. Build and verify a smoke PDF.
7. Report completion only after the required stages pass.

The technical stage names in diagnostic logs are `preflight`, `consent`,
`install`, `re-probe`, `scaffold-migrate`, `smoke-compile`, and `complete`.
Interrupted setup can resume from persisted state. A stale successful result is
not enough to verify a changed environment. When migration finds edited files,
Compare files and Keep my files preserve the existing bytes and make the proposed
replacement reviewable.

Python environment setup is optional and separately observed. Its final Python
and package checks must pass before it reports success.

## Read-only doctor

The extension and headless tools use the same structured report. Each check has
an `ok`, `warning`, `error`, or `skipped` status and identifies whether it is
required. A required warning, error, or skipped check prevents readiness.
Optional Python or absent editor checks in a generic headless environment do not
by themselves block readiness. Installation explicitly requires its selected
editors to verify the expected extension version.

The light doctor checks packaged asset paths and hashes, actual executable
version results, editor extension versions, and workspace state. A binary that
exists but fails its version command is broken. Activation only reads a cached
light result; a cache miss waits for an explicit Inkwell action instead of
starting a background package scan.

The full doctor adds a tiny Pandoc/pandoc-crossref conversion, TeX distribution
and ownership classification, the exact packaged file requirements, and a
default Inkwell PDF compile. Full health uses disposable temporary fixtures and
removes them afterward. It does not modify project files, install software,
run texhash or Homebrew, access the network, or change ownership. Installation
and project migration are separate setup stages.

Cached reports are invalidated after installation or repair and when their
environment fingerprint changes. The fingerprint includes the extension and
requirements versions, executable paths and observed versions, TeX root and
database timestamps, and relevant asset and workspace state. Warm cached checks
do not start subprocesses.

From an extracted release's `extension` directory, or after packaging the source:

```bash
node out/doctor-cli.js --light --json
node out/doctor-cli.js --full --text
node out/doctor-cli.js --full --json --editor cursor --workspace /absolute/project
```

The CLI returns zero only when required checks pass. It returns one for a
not-ready report and two for argument or execution errors. `--editor cursor`
and `--editor code` require exact installed extension verification in those
editors. Omit `--workspace` to inspect capabilities without selecting a project.
The full CLI invokes the packaged Inkwell compiler; it cannot pass by accepting
a successful callback without a validated PDF.

## Linux

Install Pandoc, a compatible pandoc-crossref release, TeX Live, and Mermaid CLI
through your platform's supported package managers. Install the release VSIX,
then use Setup / Repair for diagnostics and project setup. Automatic system
installation is currently implemented for macOS. Use the owning package manager
for a system-managed TeX installation.

## Release verification requirements

The VSIX verifier checks required bundled entry points, templates and assets,
requirements, filters, CSL, guides, and examples against the packaged hash
manifest. The release tag must equal `v${package.json.version}`. A missing tap
credential or unmatched cask checksum leaves release publication incomplete.

The Phase 3 release record must also include:

- Warm activation p95 at or below 200 ms on the named benchmark machine, with
  no `kpsewhich`, texhash, Homebrew, or network calls. A pure doctor fixture
  benchmark alone does not establish the editor activation result.
- Apple Silicon Cursor installed only as an app, with no shell CLI, and the
  corresponding Intel VS Code case on available Intel CI or a documented machine.
- Cursor-only, VS Code-only, and both-editor installation and exact-version checks.
- Existing user TinyTeX retained without sudo or ownership changes, and existing
  system MacTeX retained without replacement or recursive ownership changes.
- Broken executable, incompatible crossref filter, interrupted setup, and
  premature-completion regression cases.
- A clean-machine run in which the initial fully qualified Homebrew install
  command produces the verified smoke PDF without another shell command.

Mocked editor and tap lifecycle matrices, local read-only tool probes, and
artifact audits cover parts of this contract. They must be identified as such;
they are not substitutes for the clean-machine or architecture-specific release
tests. The tap's final checksum remains pending until the final VSIX is built.
