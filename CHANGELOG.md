# Changelog

## 0.3.1 (2026-04-19)

Follow-up to v0.3.0. Completes items 5 (full toolchain check) and 7 (CI regression compile) from the reliability backlog.

### Added

- **Toolchain: version-floor checks.** `pandoc --version` and `pandoc-crossref --version` are now parsed and compared against tested minimums (pandoc \u2265 3.0.0, pandoc-crossref \u2265 0.3.0). Older versions produce a yellow warning in **Inkwell: Check / Install Toolchain** with a one-click `brew upgrade` remediation. Unknown versions do not trigger the warning.
- **Toolchain: automatic ls-R refresh when packages appear missing.** The package probe now runs in two passes: first against whatever state the file index happens to be in, then (only if anything is missing) after a `texhash` / `mktexlsr` refresh. Packages that transition from missing to found after the refresh were only missing because the index was stale, not because they were actually absent. The status line reports "rescued after running texhash; file index was stale" when this happens, so the user sees the cause instead of being stuck in a "tlmgr install, compile, still fails" loop.
- **Toolchain: "Rebuild file index (texhash)"** button in the package-install prompt. Opens a terminal with the right `texhash` command (falls back to `sudo texhash` for root-owned trees).
- **CI: compile-demos workflow.** `.github/workflows/compile-demos.yml` runs on every PR that touches a template, the requirements list, or the compile pipeline. Boots a fresh Ubuntu runner, installs pandoc + pandoc-crossref + TinyTeX, applies `requirements-latex.txt` via `tlmgr install`, probes the critical v0.3.0-added packages via `kpsewhich` to catch regressions in the package list itself, then compiles every `examples/demo-*.md` through the same two-stage (pandoc -> .tex, engine x 2) pipeline the extension uses. PDFs are uploaded as a workflow artifact on success; `.tex` and `.log` files are uploaded on failure. This catches exactly the class of failures the v0.3.0 release report identified \u2014 missing TinyTeX packages, unresolved cross-refs, babel-language crashes \u2014 before they ship.
- **`scripts/compile-demo.sh`** and **`scripts/compile-all-demos.sh`.** Standalone reimplementations of the extension's compile pipeline. Used by the CI workflow; also useful locally when a user wants to reproduce an extension compile failure from the shell or debug a template change without firing up Cursor.
- **`npm run test:installer`** now bash-syntax-checks the new demo-compile scripts in addition to the macOS installer.

## 0.3.0 (2026-04-19)

Reliability release. Addresses five classes of failure observed during automated PDF rebuilds on a clean TinyTeX install. Every one of these produced a failing compile or a silently corrupted PDF on machines without a full MacTeX.

### Fixed

- **rho and rmxaa templates: unconditional `\\iflanguage{spanish}` crashes on babel-english-only installs.** The rho class's `rhobabel.sty` and the rmxaa class's `rhobabel.sty` both contain ~20 `\\iflanguage{spanish}{...}{...}` branches. `\\iflanguage` is a hard error (not a silent `false`) when the language has not been declared to `babel`. The previous template wrappers loaded `\\usepackage[english]{babel}`, so the condition was always undefined unless the user's format file happened to have Spanish preloaded \u2014 which TinyTeX and BasicTeX do not. Load `[spanish,english]{babel}` in both template wrappers so the condition resolves, with `english` remaining the primary language. Add `babel-spanish` and `hyphen-spanish` to the shipped requirements list so the language is actually available when tlmgr is used for the initial package pass.
- **Compile: two-pass engine resolution for cross-references.** The single-pass `pandoc --pdf-engine=...` flow ran the engine only once, which left `\\ref{...}`, `\\pageref{LastPage}`, `\\tableofcontents`, and pandoc-crossref's internal refs unresolved. Every rho / rmxaa PDF showed `Page 1 of ??` on a cold cache, and any \u2198`@fig:` / `@tbl:` / `@eq:` / `@sec:` reference fell through to a literal `??`. The pipeline now emits the template-processed `.tex` first, then runs the engine twice; raw-LaTeX `\\cite{...}` paths also get a biber / bibtex pass when the generated `.tex` contains a `\\bibliography{...}` or `\\addbibresource{...}` line.
- **Missing TinyTeX packages.** Clean TinyTeX installs of the default / rho / rmxaa templates hit `File 'xstring.sty' not found` or `fixtounicode.sty` on first compile. Add `xstring`, `fix2col`, `babel-spanish`, `hyphen-spanish` to `requirements-latex.txt` and to the `toolchain.ts` fallback list. Map `babel-spanish`, `hyphen-spanish`, `fix2col` in the `kpsewhich` probe so the toolchain check correctly reports their install state instead of always reporting them missing.

### Added

- **Toolchain: TEXMFROOT ownership + writeability check.** `kpsewhich -var-value TEXMFROOT` is probed, and when it resolves to a directory owned by a user other than the current one AND not writable by the current user, the toolchain report surfaces the ownership mismatch and offers a one-click `sudo chown -R "$USER" "$TEXMFROOT"` remediation. This is the single hardest-to-diagnose failure mode for TinyTeX bootstrapped via `curl ... | sudo sh`: `tlmgr install` succeeds silently but `kpsewhich` never sees the new files because the `ls-R` index cannot be updated as a non-root user.
- **Install script: ownership warning.** `scripts/install-inkwell-macos.sh` now runs the same `kpsewhich` ownership check post-install and prints an actionable warning with the exact `chown` command when the TeX tree is root-owned.
- **Compile log: full pandoc argv.** The extension's Inkwell output channel now logs the exact `pandoc` argv (including `TEXINPUTS`, `--resource-path`, and every engine-pass command) in a form that can be pasted into a terminal to reproduce a failure outside the extension. Previously this required reading the minified bundle.
- **`guide.md`: Troubleshooting section.** Documents the symptoms and remediations for the failure modes above, plus the preview-webview-not-refreshing case and how to find the compile invocation in the output channel.

### Template coverage audit

- **rho**: babel fix applied (`[spanish,english]{babel}`).
- **rmxaa**: babel fix applied (wrapper previously loaded no babel at all).
- **tufte, ludus, tmsce, inkwell.latex**: no `\\iflanguage` or babel issues.
- **eth-report**: self-contained `[ngerman, english]{babel}` load; unaffected.
- **kth-letter**: already uses `\\@ifpackageloaded{babel}` guards; unaffected.

## 0.2.10 (2026-04-19)

- **Preview: stop regex transforms from eating the blank line after a `{#label}` attribute.** The body pre-processors used `\s*$` with the `/m` flag when stripping Pandoc attribute blocks (heading `{#sec:...}`, table caption `{#tbl:...}`, `:::` fenced-div refs slot, and the catch-all trailing-attrs sweep). JavaScript's `\s` matches `\n`, so a greedy `\s*$` consumed the blank line *after* the attribute and glued the next markdown block onto the previous one. Downstream, markdown-it saw a `<figcaption>...</figcaption>` on one line immediately followed by `## Heading` and `1. List item`, which triggers CommonMark's HTML-block rule: the heading and the list got swallowed into the HTML block and were rendered as literal text instead of as a heading and an ordered list. Replace `\s*$` with `[ \t]*$` (and similarly for the leading side where present) so only horizontal whitespace is consumed, preserving the blank line that markdown-it needs as a block separator.

## 0.2.9 (2026-04-19)

- **Print button now renders a PDF.** `window.print()` inside a VS Code webview is unreliable (the sandbox often swallows the dialog silently), so the Print toolbar button now triggers the same Pandoc + XeLaTeX compile pipeline as the Compile button. The PDF shows in the PDF tab when it is ready.
- **Heading typography controls.** `inkwell.heading-font`, `inkwell.heading-color`, `inkwell.heading-weight`, and `inkwell.heading-scale` apply to `h1` through `h6`. Defaults remain unchanged; `heading-scale` is a single multiplier so you can push every heading up or down together. Already-supported `mainfont` / `monofont` continue to control body and mono type.
- **Code and caption font sizes.** `inkwell.code-font-size` (applies to `<pre><code>`) and `inkwell.caption-font-size` (applies to `figcaption` and `.table-caption`). Accepts any CSS length or the named sizes the existing `table-font-size` accepts.
- **Section numbering styles.** `inkwell.section-numbering: decimal | legal | none`.
  - `decimal` (default): `1`, `1.1`, `1.1.1`
  - `legal` / `outline`: `1`, `1.b`, `1.b.iii`, `1.b.iii.(2)`, `1.b.iii.(2).(e)`
  - `none`: no auto-numbering; the heading text renders on its own. Figure and table prefixes still number normally.

## 0.2.8 (2026-04-19)

- **Preview: honor Pandoc `::: {#refs} :::` placeholder.** The rendered References section now lands at the author-controlled slot (Pandoc's `::: {#refs} :::` fenced div, as used by the rho / rmxaa / tufte templates) instead of being appended to the end of the document after every appendix. When no placeholder is present, we still append at the end.
- **Preview: always render a References section when citations are present.** When every cited key is missing from the bibliography, pandoc emits no `<div id="refs">` block, so the earlier preview simply showed no References section at all \u2014 users ended up staring at broken-looking cites with no explanation. A stub References section is now synthesized listing each unresolved key under `<em>(not in bibliography)</em>` with a one-line note saying the bibliography resolved 0 of N cites. The stub makes the missing state obvious and tells the reader what entries to add.
- **Preview: softer missing-citation rendering.** Pandoc emits missing cites as `(<strong>key?</strong>)` which reads like a compile error. Replace with a cleaner `<em>[key]</em>` in subtle gray (shares the `.citation-missing` class so the print view and the stub references section style consistently). The `data-cites` attribute and the link-to-refs anchor are preserved so cached keys and click-to-scroll still work.

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
