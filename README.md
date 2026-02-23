# Inkwell

I love LaTeX. I love Cursor. I love science. I hate redoing my science to fit within the LaTeX modality, and more and more I'm using Cursor for writing.

Inkwell lets you stay in markdown, stay in your editor, and still get publication-quality PDFs out the other end. Your analysis scripts run in place, their outputs land in the document, and the whole thing compiles to LaTeX without you ever opening a `.tex` file. Or open one. It handles those too.

## What it does

**Write in markdown.** Preview it live with math and diagrams. When you're ready, compile to PDF through Pandoc and XeLaTeX. Pick a journal template. Tweak formatting from your frontmatter. Done.

**Run your code in place.** Point a code block at a Python script. Hit Run. The figure it produces shows up in your preview and in your compiled PDF. Change the script, run again, everything propagates. Outputs are cached by content hash, so unchanged blocks don't re-execute.

**Keep your science and your document together.** No copying results into tables. No re-exporting figures. No context switching between your analysis environment and your writing environment. One directory, one workflow.

## Getting started

Run **Inkwell: New Project** from the command palette. It walks you through:

1. Pick a folder
2. Name your document
3. Choose a LaTeX template (or use the default)
4. Optionally set up a Python venv

You get this:

```
my-paper/
  my-paper.md              # your document
  scripts/                 # analysis code
  figures/                 # static images, diagrams
  references/              # .bib files, citation data
  requirements.txt         # Python dependencies (if enabled)
  venv/                    # Python environment (if enabled)
  .inkwell/
    manifest.json          # project config (template, settings)
    outputs/               # cached code block results (gitignored)
  .gitignore
```

The `.inkwell/` directory is where Inkwell keeps its state. `manifest.json` records which template you're using. `outputs/` caches code block results so unchanged blocks skip re-execution. Both are managed automatically.

Everything else is yours. Put scripts in `scripts/`, figures in `figures/`, bibliography files in `references/`. The structure is a convention, not a requirement; Inkwell works with any layout.

## Features

### Live preview

Side panel (`Cmd+Shift+V`) with three tabs:

- **Preview**: HTML rendering with KaTeX math and Mermaid diagrams, updates as you type
- **PDF**: compiled output rendered in-panel
- **Log**: compilation output, code block stderr, errors

### Runnable code blocks

Embed scripts directly or reference external files. Python, R, Shell, Node.

```markdown
---
inkwell:
  code-display: output
  python-env: ./venv
---
```

````markdown
```{python file="scripts/analysis.py" output="results" caption="My figure" label="analysis"}
```

```{shell display="both"}
echo "Built on $(date)"
```
````

- `file`: run an external script instead of inline code
- `output`: name for cached artifacts (figures, tables)
- `display`: visibility per block (`output`, `both`, `code`, `none`)
- `env`: point a specific block at a different venv
- `caption`: figure or table caption in the compiled PDF
- `label`: cross-reference label (produces `fig:label` or `tbl:label`)

Results cache in `.inkwell/outputs/`. Only re-run when the code actually changes.

### Citations and bibliography

Add a `.bib` file to your `references/` directory and reference it in your frontmatter:

```yaml
bibliography: references/refs.bib
link-citations: true
```

Cite with standard Pandoc syntax: `[@knuth1984]`, `[@harris2020; @hunter2007]`. Inkwell runs `--citeproc` automatically. A formatted bibliography appears wherever you place a `## References` heading.

### Table of contents, list of figures, list of tables

Enable from frontmatter:

```yaml
toc: true
lof: true
lot: true
```

These generate standard LaTeX `\tableofcontents`, `\listoffigures`, and `\listoftables` in the compiled PDF.

### Python environments

Set `python-env: ./venv` in your frontmatter for the whole document, or `env="./other-venv"` on a single block. The **Setup Python Environment** command creates the venv and installs from `requirements.txt`.

### Templates

Inkwell ships with four templates:

| Template | Description |
|---|---|
| **Inkwell Default** | Clean article with theorem environments, code highlighting, title page |
| **TMSCE** | Transactions on Mathematical Sciences and Computational Engineering |
| **Ludus Academik** | Ludus Academik Journal |
| **RMxAA** | Revista Mexicana de Astronomia y Astrofisica (v4.6) |

Each journal template includes a Pandoc-compatible `.latex` wrapper that compiles with the journal's native document class. Journal-specific metadata (DOI, volume, issue, author affiliations, received/accepted dates) is set through YAML frontmatter variables.

Add your own by dropping a template directory (with a `template.json` manifest) into `~/.inkwell/templates/`. Any Overleaf or journal template works. Project-local templates go in `.inkwell/templates/` within your project.

Use **Select LaTeX Template** from the command palette to switch.

### Formatting from frontmatter

Style the compiled output without editing LaTeX:

```yaml
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  code-font-size: small
  tables: booktabs
  table-font-size: small
  hanging-indent: true
  columns: 2
```

### Toolchain setup

Inkwell checks for Pandoc and XeLaTeX on activation. If they're missing, it walks you through installing them:

- **macOS**: Homebrew or TinyTeX
- **Linux**: apt/dnf or TinyTeX

## Commands

| Command | Shortcut | |
|---|---|---|
| New Project | | Scaffold an Inkwell project with structure and config |
| Open Preview | `Cmd+Shift+V` | Live HTML, PDF, and log tabs |
| Compile PDF | `Cmd+Shift+R` | Pandoc + XeLaTeX |
| Run Code Blocks | `Cmd+Shift+B` | Execute blocks, cache results |
| Cancel Run | | Stop in-progress execution |
| Clear Cache | | Force all blocks to re-run |
| Export PDF | | Save to a specific file |
| Select Template | | Pick from installed templates |
| Setup Python Env | | Create venv, install deps |
| Check Toolchain | | Verify or install Pandoc/XeLaTeX |

## Settings

| Setting | Default | |
|---|---|---|
| `inkwell.autoCompile` | `off` | `off`, `onSave`, or `interval` |
| `inkwell.autoCompileIntervalSeconds` | `60` | Seconds between interval compilations |
| `inkwell.defaultCodeDisplay` | `output` | Default code block visibility |

## Requirements

- [Pandoc](https://pandoc.org/)
- [XeLaTeX](https://tug.org/xetex/) via TeX Live, BasicTeX, MacTeX, or TinyTeX
- Python 3 (optional, for runnable Python blocks)

Inkwell will detect what's missing and help you install it.
