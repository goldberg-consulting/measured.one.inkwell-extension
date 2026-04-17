# Changelog

## 0.2.3 (2026-04-17)

- **Package only pure template assets in the VSIX.** Earlier builds shipped `demo.md`, `examples/*.md`, `examples/*.pdf`, `guide.md`, `media/examples/*.png`, and generated `.inkwell/` artifacts (mermaid cache, compiled markdown). The published VSIX now contains `templates/`, the bundled extension code, the extension icon, and standard metadata (`LICENSE`, `README.md`, `CHANGELOG.md`, `package.json`) only. Setup Workspace continues to function \u2014 `copyGuide` and `copyDemoFiles` both fall back silently when the optional sources are absent.
- **Purged prior VSIX releases.** The `v0.2.1` and `v0.2.2` GitHub release assets, which contained personal scratch content alongside the template fixes, have been removed. Install this release (`v0.2.3`) or `brew upgrade --cask inkwell` to get a clean bundle.

## 0.2.2 (2026-04-17)

- **Rho template: reduce table whitespace.** The v0.2.1 fix eliminated the infinite-page loop on tall tables by wrapping every `longtable` in `\onecolumn` / `\twocolumn`, which forced a full column flush before and after each table. On documents with many tables this left large empty regions and inflated page count (40 pages for the 1000-line reference document, most of it blank). The revised approach redirects `longtable` to `\begin{table*}[!tbp]` + `\tabular`, a two-column-spanning float with flexible placement. LaTeX's float mechanism then places each table at the top, bottom, or on a dedicated float page, whichever fits. Same reference document now compiles to 18 pages with no infinite-loop risk.

## 0.2.1 (2026-04-17)

- **Rho template: fix infinite-loop compile on tall tables.** The previous `longtable` redefinition forced every table into `\begin{table}[H]` + `\tabular`. Tables that did not fit on a page silently overflowed the output routine and sent xelatex into an unbounded page loop (`xdvipdfmx:fatal: Page number 65536 too large`), typically after a minute or more of apparent hang. The replacement wraps the original `longtable` in a `\onecolumn` / `\twocolumn` switch so page-breaking works inside rho's twocolumn layout. Compile for a 1000-line document with 17 longtables drops from unbounded to under 10 seconds.

## 0.2.0 (2026-04-05)

- **Homebrew cask install**: `brew tap goldberg-consulting/inkwell && brew install --cask inkwell` installs the extension plus Pandoc, pandoc-crossref, and MacTeX in one command.
- **Merged Bootstrap and Update** into a single idempotent **Setup Workspace** command. Run it once for initial setup, re-run after extension updates to backfill new files.
- **Run Code Blocks shortcut** changed from `Cmd+Shift+B` (conflicted with VS Code's Run Build Task) to `Cmd+Alt+R`.
- **Stability fixes**: `inkwell.installPackage` command wired end-to-end, compile queue-latest behavior, `try/finally` cleanup for run progress, `pandoc-crossref` argument guard, explicit cache hit/miss metadata.
- **Packaging**: replaced `files` whitelist with `.vscodeignore`, added CI bundle gate (`npm run package`), shortcut/command stability regression checks, pre-commit config.
- **Release automation**: GitHub Actions workflow builds VSIX on release publish and auto-bumps the Homebrew tap cask.

## 0.1.9 (2026-03-19)

- **Bootstrap Workspace** now runs the same **starter file** seeding as New Project / Update Project: `sine_plot.py`, `scatter.py`, **`convergence_table.py`**, `refs.bib`, `figures/.gitkeep`.
- New Project (`createStructure`) uses shared **`ensureStarterFiles`** instead of duplicating writes.

## 0.1.8 (2026-03-19)

**Extension repository layout:** demo assets (Python scripts, `refs.bib`) now live under **workspace root** `.inkwell/scripts/` and `.inkwell/references/`, not `examples/scripts/` or `examples/references/`. Example markdown again uses `.inkwell/…` paths. VSIX packaging includes those tracked `.inkwell/` files; build artifacts stay gitignored.

## 0.1.7 (2026-03-19)

**Project root for all `.inkwell` artifacts** (fixes nested `.inkwell/` beside deep `.md` files).

- Code block cache, Mermaid PNG/SVG, and injected `compiled` markdown now live under the **Inkwell project root** (first ancestor containing `.inkwell/`), not next to the source file.
- Per-document paths: `.inkwell/outputs/<doc-key>/` and `.inkwell/compiled/<doc-key>.<ext>` where `<doc-key>` is the source path relative to the project (e.g. `examples--demo-default`).
- Block `file="..."` resolution: try **document folder** first, then **project root** (so `.inkwell/scripts/…` works from nested markdown).
- Code block **cwd** and Python env resolution prefer the project root; **Setup Python Env** `./.inkwell/venv` resolves to the project `.inkwell/`, not the document directory.
- Preview webview **localResourceRoots** include the project root for mermaid/output assets.
- Scaffold / gitignore: `.inkwell/compiled/` directory (replaces flat `compiled.*` ignore).

## 0.1.6 (2026-03-19)

PATH construction for subprocesses (Mermaid CLI, Pandoc/TeX) so **GUI-launched** VS Code/Cursor finds **`mmdc`** when Node tools live under **nvm**, **fnm**, or **Volta**.

- Added `src/shell-env.ts`: `buildCodeBlockPath`, `buildTexInvocationPath`, `collectNodeToolBinDirs`, `findBinaryViaShell` (login-shell fallback; Windows `where`)
- **`inject`**: dynamic `getInjectEnv()`, one-time shell resolution + prepend if `mmdc --version` fails; log PATH head to **Inkwell LaTeX** on failure
- **`compiler`**: `TEX_ENV.PATH` uses `buildTexInvocationPath()` (same node-manager coverage, TeX-first order)
- **`toolchain`**: search paths include `~/.npm-global/bin` + node-manager bins; **`mmdc`** probe uses shell fallback
- **`inkwell-output`**: singleton output channel; **preview** uses it
- **README**: VSIX smoke-test, troubleshooting for Node managers + output channel, packaging tip

## 0.1.5 (2026-03-19)

Scaffold resources consolidated into `.inkwell/` for a cleaner project layout.

- Moved `scripts/`, `figures/`, `references/`, and `examples/` under `.inkwell/` in both New Project and Bootstrap Workspace flows
- Updated bibliography discovery and compilation to search `.inkwell/references/` and `.inkwell/figures/`
- Updated guide and cursor agent docs to reflect new resource paths
- Added `.inkwell/mermaid/` to the default `.gitignore` template
- Bumped scaffold version to 3
- Fixed Bootstrap Workspace command being hidden when any `.inkwell/` directory existed in the workspace
- Restructured README install flow: extension first, toolchain second, workspace bootstrap third
- Fixed toolchain setup re-downloading MacTeX (~5 GB) when a TeX distribution is already installed
- New Project now scaffolds template-specific YAML frontmatter (authors, affiliations, journal metadata) for Ludus, Rho, RMxAA, TMSCE, Tufte, and KTH Letter
- Added "default" as an alias for the Inkwell Default template so `template: default` resolves correctly
- Added ETH Report template (ETH Zürich IVT working paper style, KOMA-Script article, pdfLaTeX)
- Added `babel-german`, `koma-script`, and other ETH class dependencies to `requirements-latex.txt`
- Updated all demo `.md` examples to use `.inkwell/` paths (bibliography, scripts, figures)
- Added Run Code Blocks button to the editor title bar (no longer requires the preview panel to be open)
- Fixed mermaid `mmdc` availability cache (now rechecks every 30s instead of caching forever)
- Mermaid render failures are now logged instead of silently swallowed

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
