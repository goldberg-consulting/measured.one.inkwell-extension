---
name: inkwell-troubleshooting
description: Diagnose Inkwell extension failures - compile errors, missing templates, stale installs, wrong PDF output, broken cross-references, and toolchain problems. Use when a PDF compile fails, output looks wrong (missing pages, "??" references, wrong template), a new template or example doesn't appear, or brew/VSIX installation misbehaves.
---

# Inkwell Troubleshooting

Diagnostic workflow for the Inkwell extension (markdown → Pandoc → LaTeX → PDF). Work through the sections in order; each starts with the fastest check.

## 1. Reproduce outside the extension first

The extension's pipeline is mirrored by a standalone script. Always reproduce with it before touching extension code:

```bash
scripts/compile-demo.sh examples/demo-<template>.md --keep-work
```

- Exit 1 = pandoc failed (template syntax, frontmatter). Exit 2 = LaTeX engine failed (check the preserved workdir's `.log`).
- `--keep-work` preserves the temp dir; inspect the generated `.tex`, `.aux`, `.toc`, and `.log` there.
- `scripts/compile-all-demos.sh` compiles every demo and prints a pass/fail summary — run it after any template or compiler change.

If the script succeeds but the extension fails, the problem is extension-side: see sections 2 and 5.

## 2. Extension compiles the wrong thing / new template missing

The running extension loads from the *installed* copy, not this repo:

- Installed copies live at `~/.cursor/extensions/measure-one.inkwell-<version>/` (or `~/.vscode/extensions/`). Check whether `templates/<name>/` exists **there**.
- The extension resolves templates from three locations, ascending priority: built-in (`<extension>/templates/`), global (`~/.inkwell/templates/`), project (`.inkwell/templates/`). A stale global/project copy silently shadows a newer built-in — but only if it has its own `.latex` wrapper.
- The **Inkwell Templates** output channel logs which template was resolved and why. The compile log's first lines (`[inkwell] template: ...`) show the resolved directory.
- Fix: rebuild + reinstall (`npx @vscode/vsce package --no-dependencies`, then `cursor --install-extension inkwell-<version>.vsix --force`), then **Developer: Reload Window**. A reload is always required — old code stays in memory.

## 3. Reading compile failures

- **Inkwell LaTeX** output channel (View → Output) has the full pandoc argv, `TEXINPUTS`, engine passes, and a log excerpt. The argv can be pasted into a terminal verbatim.
- `Missing file: foo.sty` → `tlmgr install <pkg>`; `src/toolchain.ts` has the file→package map (`FILE_TO_PACKAGE`) for files whose tlmgr package name differs.
- Packages installed but still "not found" → stale ls-R index or root-owned TeX tree. Run `texhash`; if that fails, check `kpsewhich -var-value TEXMFROOT` ownership (`sudo chown -R "$USER" "$TEXMFROOT"`).
- Engine is a hard requirement from `template.json` (`pdflatex` vs `xelatex`); a missing engine fails fast with an actionable message, never silently substitutes.

## 4. Wrong-looking output

- **Only 2 pages / default styling instead of the template**: the template didn't resolve — see section 2.
- **`#` headings are sections, not chapters (book templates)**: frontmatter must contain `top-level-division: chapter`; the compiler forwards it to pandoc as a CLI flag (`extractTopLevelDivision` in `src/compiler.ts`). `compile-demo.sh` mirrors this.
- **Figure refs print "??" or blank in Tufte templates**: the wrappers spoof `caption`/`subcaption` as loaded (pandoc-crossref injects them otherwise) and re-route `\ltx@label` inside floats (amsmath reverts the tufte class's label deferral in minipages). Both guards live in `templates/tufte/tufte.latex` and `templates/tufte-book-vdqi/tufte-book-vdqi.latex` — keep them when editing.
- **Cross-refs `??` on first compile only**: expected; the pipeline runs the engine twice for exactly this. If it persists, check the second engine pass actually ran in the log.

## 5. Installation and update problems

- `Refusing to load cask ... from untrusted tap` → `brew trust goldberg-consulting/inkwell`, then retry.
- **Setup Workspace didn't pick up new examples**: it copies into `.inkwell/examples/` only when missing, never overwrites. Delete the stale file, re-run **Inkwell: Setup Workspace**.
- Missing bundled content warning → the VSIX was built with an over-aggressive `.vscodeignore`; `examples/`, `guide.md`, and `templates/` must ship (see the annotated `.vscodeignore`).
- Release flow: bump `package.json`, `npm run verify`, tag + publish a GitHub release; `.github/workflows/release.yml` builds the VSIX, uploads it, and bumps the Homebrew tap cask automatically.

## 6. Validation before declaring fixed

```bash
npm run verify                    # typecheck, lint, regression, stability, error-parsing, installer checks
scripts/compile-all-demos.sh      # every template end-to-end
```

Render a page to inspect visually (Ghostscript ships with MacTeX/brew):

```bash
gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r100 -dFirstPage=1 -dLastPage=1 -o /tmp/page1.png examples/demo-<t>.pdf
```
