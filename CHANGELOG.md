# Changelog

## 0.1.5 (2026-03-19)

Scaffold resources consolidated into `.inkwell/` for a cleaner project layout.

- Moved `scripts/`, `figures/`, `references/`, and `examples/` under `.inkwell/` in both New Project and Bootstrap Workspace flows
- Updated bibliography discovery and compilation to search `.inkwell/references/` and `.inkwell/figures/`
- Updated guide and cursor agent docs to reflect new resource paths
- Added `.inkwell/mermaid/` to the default `.gitignore` template
- Bumped scaffold version to 3
- Fixed Bootstrap Workspace command being hidden when any `.inkwell/` directory existed in the workspace
- Restructured README install flow: extension first, toolchain second, workspace bootstrap third

## 0.1.4 (2026-03-18)

Installer guidance and docs now consistently point to full LaTeX dependency provisioning.

- Updated toolchain setup instructions to include full `requirements-latex.txt` install commands
- Extended Linux apt/dnf setup flow to attempt full `tlmgr` requirements install when available
- Updated README install steps to recommend `Inkwell: Check / Install Toolchain` and include full package install snippets
- Added `fixtounicode` to required LaTeX packages and corrected `extsizes` detection to check `extarticle.cls`

## 0.1.3 (2026-03-18)

Toolchain setup now installs full LaTeX template dependencies more reliably.

- Updated setup installers to install the complete `requirements-latex.txt` package set for Homebrew + TinyTeX flows
- Added more robust `tlmgr` and `texhash`/`mktexlsr` command resolution in package install path
- Added `pbalance` and `extsizes` to tracked LaTeX requirements to cover known template dependencies

## 0.1.2 (2026-03-18)

Workspace bootstrap improvements for non-Inkwell repositories.

- Added `Inkwell: Bootstrap Workspace (.inkwell Folder)` to initialize a top-level `.inkwell` in existing repos
- Added conditional command visibility (command palette + editor title) when no Inkwell project root is detected
- Added optional seeding of bundled templates into `.inkwell/templates` during workspace bootstrap
- Updated non-project guidance in `Inkwell: Update Project` to point users to bootstrap flow

## 0.1.1 (2026-03-10)

Release refresh with packaging and reliability fixes.

- Fixed RMxAA compilation when `logo` is omitted by only defining `\logofile` when provided
- Improved missing Python env guidance for code block runs; warning now points to `requirements.txt`-based recovery path
- Switched to an explicit VSIX file whitelist in `package.json` for reproducible release contents
- Kept scaffold assets in shipped package (`examples/*.md`, `guide.md`, `.cursor/agents/inkwell-guide.md`)

## 0.1.0 (2026-02-22)

Initial release.

- Live preview panel with HTML, PDF, and log tabs
- Pandoc + LaTeX compilation (XeLaTeX and pdfLaTeX, selected per template)
- Runnable code blocks: Python, R, Shell, Node with content-addressed caching
- Four built-in templates: Inkwell Default, TMSCE, Ludus Academik, RMxAA
- Custom template support via global (`~/.inkwell/templates/`) or project-local (`.inkwell/templates/`) directories
- YAML frontmatter styling: code backgrounds, borders, font sizes, booktabs tables, column layout
- Citation support via `--citeproc` with automatic `.bib` file discovery
- New Project scaffolding command
- Toolchain detection with guided Pandoc and LaTeX installation
- Python venv management per document or per block
