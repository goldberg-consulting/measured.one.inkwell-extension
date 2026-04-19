# Changelog

## 0.2.7 (2026-04-19)

- **Preview: mask LaTeX typesetting directives.** Stand-alone `\newpage`, `\clearpage`, `\cleardoublepage`, and `\pagebreak[N]` are replaced in the preview (and the print view) with a subtle dashed rule labelled "page break". Cosmetic spacing commands (`\vspace{..}`, `\hspace{..}`, `\vfill`, `\hfill`, `\bigskip`, `\medskip`, `\smallskip`, `\nopagebreak`, `\noindent`, `\par`, `\null`) are stripped silently. The source markdown is untouched, so the LaTeX compile pipeline still sees the directives verbatim. When the preview is printed through the browser, the page-break marker converts to an actual `page-break-after: always` so the break lands where the author asked for it.
- **Preview: default mermaid height cap.** Uncontrolled diagrams were stretching the preview to multiple screens tall. Default `--mermaid-max-height: 70vh` applied to `.mermaid`, overridable via the existing frontmatter (`inkwell.mermaid-max-height`) or per-fence (`{mermaid max-height="400px"}`) mechanisms.

## 0.2.6 (2026-04-19)

- **Preview: root-cause fix for code blocks rendering without newlines.** `addDataLineAttrs` used the regex `/<(h[1-6]|p|pre|blockquote|table|ul|ol|li|hr)/g`. JavaScript regex alternation takes the *first* matching alternative, not the longest, so every `<pre>` tag was matched as `<p` (because `p` appears before `pre` in the list). The replacement then emitted `<p data-line="N"re>`, which the HTML parser silently collapses to a plain `<p>` tag with trailing garbage discarded \u2014 turning every fenced code block into a paragraph, losing `white-space: pre`, and collapsing all newlines into spaces. The earlier CSS rules (`white-space: pre-wrap`, `!important`, etc.) never took effect because the elements they targeted had already been corrupted from `<pre>` to `<p>` before reaching the DOM. Reorder alternations to put longer tokens first (`pre` before `p`) and add a `(?=[\s>])` lookahead so tag boundaries are respected.

## 0.2.5 (2026-04-19)

- **Preview: block math now renders as a proper centered display block.** The v0.2.4 math shield substituted `$$...$$` with a bare placeholder that markdown-it wrapped in a `<p>`. KaTeX's display-mode renderer emits a block-level `.katex-display` span, and nesting that inside a `<p>` forced the browser to auto-close the paragraph, which in turn broke the vertical rhythm and left the equation left-aligned where users expected it centered. Block math is now wrapped in `<div class="math-display">` (with surrounding blank lines so markdown-it treats it as an HTML block) and a matching CSS rule centers the output.
- **Preview: force code-block whitespace preservation with `!important`.** The v0.2.4 `white-space: pre-wrap` rule was being overridden in practice \u2014 the host webview's default stylesheet (Cursor / VS Code) normalizes `<pre>` to `white-space: normal`, which collapsed newlines into spaces and produced the wrapped-paragraph effect that the earlier fix was meant to eliminate. Apply `white-space: pre-wrap`, `word-break: normal`, and `overflow-wrap: anywhere` with `!important` on `<pre>`, `<code>`, `pre code.hljs`, and nested highlight.js spans so the rule wins the cascade regardless of host defaults.

## 0.2.4 (2026-04-19)

- **Preview: live bibliography and citations.** New `src/citations.ts` renders `[@key]` / `@key` citations in the preview with full pandoc parity when `pandoc` is on `PATH` (shells out to `pandoc --citeproc` against the frontmatter `bibliography`/`csl`), and falls back to a small in-process `.bib` parser otherwise. Results are cached under `.inkwell/.cache/preview-cites/` keyed on citation tokens, bib mtimes, CSL mtime, and the `link-citations` flag.
- **Preview: math rendering fix.** `$$...$$`, `\[...\]`, `\(...\)`, and inline `$...$` spans are now shielded from markdown-it before rendering. markdown-it does not know the math delimiters, so without shielding it consumed `\_` escapes, stray `_` as emphasis, and `\*` as literal asterisks, producing red KaTeX error strings for anything with escapes inside. The shield swaps each math span for an opaque placeholder that survives markdown-it intact, then splices the original LaTeX back into the rendered HTML so KaTeX auto-render sees the source unmodified.
- **Preview: code block formatting fix.** `<pre>` now sets `white-space: pre-wrap; word-break: normal; overflow-wrap: anywhere; tab-size: 4` with `<pre><code>` inheriting. Fixes the case where webview host stylesheets let `pre` fall back to `white-space: normal`, collapsing newlines into spaces and producing wrapped-paragraph output in place of multi-line code.
- **Preview: print-ready pagination.** New print view paginates the rendered preview into `.page-sheet` elements with optional headers and footers, for direct-to-printer output without round-tripping through LaTeX.
- **Config: `findCslFile()` helper.** Locates a CSL stylesheet via the frontmatter `csl` path, falling back to project-root and `.inkwell/references/` lookups.
- **Gitignore: `.inkwell/.cache/`** added so the citation cache never enters the repo.

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
