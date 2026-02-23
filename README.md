# Inkwell

![Inkwell: Markdown to Publication-Quality PDF](media/hero-banner.png)

Inkwell lets you stay in markdown, stay in your editor, and still get publication-quality PDFs out the other end. Your analysis scripts run in place, their outputs land in the document, and the whole thing compiles to LaTeX without you ever opening a `.tex` file. Or open one. It handles those too.

## How it works

1. **Write** in markdown with YAML frontmatter for metadata and styling
2. **Run** code blocks (Python, R, Shell, Node) that produce figures, tables, and text
3. **Compile** through Pandoc and LaTeX (XeLaTeX or pdfLaTeX, per template) with your chosen journal template
4. **PDF** output with embedded results, citations, and formatted math

![Run code blocks that generate figures and tables](media/run-preview.png)

![Compile to PDF with journal formatting and embedded results](media/compile-preview.png)

## Installation

### From source

```bash
git clone https://github.com/goldberg-consulting/measured.one.inkwell-extension.git
cd measured.one.inkwell-extension
npm install
npm run compile
```

Then in VS Code / Cursor: `Cmd+Shift+P` > "Developer: Install Extension from Location..." and select the `measured.one.inkwell-extension` directory.

### Prerequisites

Inkwell needs Pandoc and a LaTeX distribution (providing both XeLaTeX and pdfLaTeX) installed on your system. On first activation, it checks for both and offers guided installation if either is missing.

**macOS (Homebrew):**

```bash
brew install pandoc
brew install --cask basictex
```

**macOS (TinyTeX, recommended):**

```bash
curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh
```

**Linux:**

```bash
sudo apt install pandoc texlive-xetex   # Debian/Ubuntu
sudo dnf install pandoc texlive-xetex   # Fedora
```

**Python** (optional, for runnable code blocks):

```bash
python3 -m venv venv
source venv/bin/activate
pip install numpy matplotlib
```

See the **[Syntax Guide](GUIDE.md)** for the complete reference on YAML frontmatter, code blocks, math, citations, and template-specific fields.

## Quick start

1. Open VS Code / Cursor
2. `Cmd+Shift+P` > **Inkwell: New Project**
3. Pick a folder, name your document, choose a template
4. Write your markdown
5. `Cmd+Shift+B` to **Run** code blocks
6. `Cmd+Shift+R` to **Compile** to PDF
7. `Cmd+Shift+V` to open the **Preview** panel

## Project structure

```
my-paper/
  my-paper.md              # your document
  scripts/                 # analysis code
  figures/                 # static images, diagrams
  references/              # .bib files
  requirements.txt         # Python dependencies (if enabled)
  venv/                    # Python environment (if enabled)
  .inkwell/
    manifest.json          # project config (template, settings)
    outputs/               # cached code block results (gitignored)
  .gitignore
```

## Features

### Live preview

Side panel (`Cmd+Shift+V`) with three tabs:

- **Preview**: HTML rendering with KaTeX math and Mermaid diagrams, updates as you type
- **PDF**: compiled output rendered in-panel
- **Log**: compilation output, code block stderr, errors

### Compilation output

Detailed build logs are available in the **Output** panel (`Cmd+Shift+U`). Select **Inkwell LaTeX** from the dropdown in the top-right corner of the panel. This shows:

- Template and PDF engine used for each compilation
- Pass/fail status with elapsed time
- LaTeX errors and warnings with line numbers
- Missing package names (with quick-fix code actions in the editor)
- Full Pandoc and LaTeX log output for debugging

### Runnable code blocks

Embed scripts directly or reference external files. Python, R, Shell, Node.

````markdown
```{python file="scripts/analysis.py" output="results" caption="My figure" label="analysis"}
```

```{python display="both" output="scatter" caption="Scatter plot with regression."}
import numpy as np
# ... your code here ...
```

```{shell display="both"}
echo "Built on $(date)"
```
````

**Code block attributes:**

| Attribute | Description |
|-----------|-------------|
| `file`    | Run an external script instead of inline code |
| `output`  | Name for cached artifacts (figures, tables) |
| `display` | Visibility: `output`, `both`, `code`, `none` |
| `env`     | Point a specific block at a different venv |
| `caption` | Figure or table caption in the compiled PDF |
| `label`   | Cross-reference label (produces `fig:label` or `tbl:label`) |

Results cache in `.inkwell/outputs/`. Only re-run when the code actually changes.

### Citations and bibliography

Add a `.bib` file and reference it in your frontmatter:

```yaml
bibliography: references/refs.bib
link-citations: true
```

Cite with standard Pandoc syntax: `[@knuth1984]`, `[@harris2020; @hunter2007]`. Inkwell runs `--citeproc` automatically. A formatted bibliography appears wherever you place a `## References` heading.

### Table of contents, list of figures, list of tables

```yaml
toc: true
lof: true
lot: true
```

### Python environments

Set `python-env: ./venv` in your frontmatter for the whole document, or `env="./other-venv"` on a single block. The **Setup Python Environment** command creates the venv and installs from `requirements.txt`.

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

## Templates

Inkwell ships with four templates. Each journal template includes a Pandoc `.latex` wrapper that compiles with the journal's native document class. Templates declare their preferred PDF engine (`xelatex` or `pdflatex`) in `template.json`; Inkwell selects the right one automatically.

| Template | Class | Engine | Description |
|----------|-------|--------|-------------|
| **Inkwell Default** | `article` | xelatex | Clean article with theorem environments, code highlighting, title page |
| **TMSCE** | `tmsce` | pdflatex | Transactions on Mathematical Sciences and Computational Engineering |
| **Ludus Academik** | `ludusofficial` | xelatex | Ludus Academik Journal (themed, two-column) |
| **RMxAA** | `rmaa-rho` | pdflatex | Revista Mexicana de Astronomia y Astrofisica (v4.6, two-column) |

Select a template with `template: tmsce` in your YAML frontmatter, or use `Cmd+Shift+P` > **Inkwell: Select LaTeX Template**.

Journal-specific metadata (DOI, volume, issue, author affiliations, received/accepted dates) is set through YAML frontmatter. See the example files in [`examples/`](examples/) for complete working documents with each template.

### Custom templates

You can add your own journal or house style by creating a template directory. Templates live in one of three locations, searched in this order:

| Location | Scope | Path |
|----------|-------|------|
| Built-in | Ships with Inkwell | `<extension>/templates/<name>/` |
| Global | All projects on this machine | `~/.inkwell/templates/<name>/` |
| Project-local | Single project only | `.inkwell/templates/<name>/` |

A global or project-local template with the same name as a built-in will override it, provided the override includes its own `.latex` Pandoc wrapper. Directories that contain only supporting files (`.cls`, `.sty`, images) without a `.latex` wrapper will not shadow a built-in template.

#### Creating a template

A minimal template directory looks like this:

```
my-journal/
  template.json          # required: manifest
  my-journal.latex       # required: Pandoc template wrapper
  my-journal.cls         # the journal's LaTeX document class
  my-journal.sty         # style files, if any
  logos/logo.png         # images referenced by the class
```

**Step 1: Create the manifest.** `template.json` declares the template name and preferred PDF engine:

```json
{
  "name": "My Journal",
  "description": "Short description shown in the template picker.",
  "engine": "xelatex"
}
```

`engine` must be `"xelatex"` or `"pdflatex"`. Inkwell selects the right one automatically at compile time.

**Step 2: Write the Pandoc template wrapper.** This is a `.latex` file that bridges Pandoc's variable system (`$title$`, `$body$`, `$for(...)$`, etc.) to the journal class. At minimum it must contain `\documentclass`, `\begin{document}`, `$body$`, and `\end{document}`. A basic starting point:

```latex
\documentclass{my-journal}

\title{$if(title)$$title$$else$Untitled$endif$}
\author{$for(author)$$author$$sep$ \and $endfor$}

% Pandoc compatibility
\providecommand{\tightlist}{\setlength{\itemsep}{0pt}\setlength{\parskip}{0pt}}

$for(header-includes)$
$header-includes$
$endfor$

\begin{document}
\maketitle

$body$

\end{document}
```

The built-in templates in `templates/` are complete working examples. `rmxaa/rmxaa.latex` shows how to handle dual-language abstracts, author affiliations with superscripts, longtable-to-float conversion for two-column layouts, and Pandoc syntax highlighting. `tmsce/tmsce.latex` and `ludus/ludus.latex` show simpler patterns.

**Step 3: Include supporting files.** Drop the journal's `.cls`, `.sty`, `.bst`, font, and image files into the template directory. Subdirectories are fine; Inkwell adds the template directory to `TEXINPUTS` so LaTeX can find files in nested paths (e.g., `\documentclass{my-class-dir/my-journal}` works).

Inkwell automatically copies these file types to the build directory:

`.cls` `.sty` `.bst` `.bib` `.def` `.fd` `.cfg` `.clo` `.ldf` `.png` `.jpg` `.jpeg` `.pdf` `.eps` `.svg` `.ttf` `.otf` `.woff` `.woff2`

**Step 4: Reference it in your document.** Set the template name in YAML frontmatter:

```yaml
---
template: my-journal
title: "Paper Title"
---
```

Or select it with `Cmd+Shift+P` > **Inkwell: Select LaTeX Template**.

#### Adapting an existing journal class

Most journal submission packages ship a `.cls` file and a sample `.tex` document. To turn one into an Inkwell template:

1. Create a directory under `~/.inkwell/templates/` (or `.inkwell/templates/` in your project)
2. Copy all `.cls`, `.sty`, `.bst`, font, and image files from the journal package
3. Create `template.json` with the journal name and the correct engine
4. Open the sample `.tex` file and translate its preamble into a `.latex` Pandoc wrapper, replacing hardcoded values with Pandoc variables (`$title$`, `$author$`, `$abstract$`, etc.)
5. Map journal-specific metadata (DOI, volume, affiliations) to custom YAML frontmatter fields and wire them into the wrapper with `$if(field)$...$endif$` blocks
6. Test with a simple markdown file to verify the output matches the journal's formatting

## Examples

The [`examples/`](examples/) directory contains working demo documents for each template. Each compiles from markdown with YAML frontmatter to a publication-ready PDF.

To try them yourself:

```bash
cd examples
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Then open any `.md` file, hit **Run**, then **Compile**.

---

### Inkwell Default

Clean single-column article with table of contents, figures, math, and syntax-highlighted code.

<table><tr>
<td width="50%">

```yaml
title: "Inkwell Default Template Demo"
author: "Inkwell"
date: "February 2026"
toc: true
lof: true
bibliography: references/refs.bib
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  tables: booktabs
```

Features: TOC, list of figures/tables, numbered equations, runnable Python code blocks with inline output, citations, theorem environments.

[Source](examples/demo-default.md) | [PDF](examples/demo-default.pdf)

</td>
<td width="50%">

![Inkwell Default output](media/examples/demo-default.png)

</td>
</tr></table>

---

### RMxAA (Revista Mexicana de Astronomia y Astrofisica)

Two-column astronomy journal with dual-language abstracts, line numbers, and the RMxAA masthead.

<table><tr>
<td width="50%">

```yaml
template: rmxaa
classoption: [9pt, twoside]
title: "Signal Decomposition in Stellar
        Light Curves"
rmxaa-authors:
  - name: "J. Smith"
    affiliations: "1"
  - name: "A. Jones"
    affiliations: "2"
rmxaa-affiliations:
  - id: "1"
    text: "Universidad Nacional, ..."
  - id: "2"
    text: "State University, ..."
resumen: |
  Demostramos la plantilla ...
keywords: "Fourier analysis, ..."
vol: 100
received: "January 15, 2026"
accepted: "February 20, 2026"
```

Features: superscripted author-affiliation mapping, Spanish resumen, journal header with volume/pages/year, corresponding author block, two-column body with numbered sections.

[Source](examples/demo-rmxaa.md) | [PDF](examples/demo-rmxaa.pdf)

</td>
<td width="50%">

![RMxAA output](media/examples/demo-rmxaa.png)

</td>
</tr></table>

---

### TMSCE (Transactions on Mathematical Sciences and Computational Engineering)

Single-column journal with DOI, received/revised/accepted dates, and keyword block.

<table><tr>
<td width="50%">

```yaml
template: tmsce
title: "On the Convergence of Fourier
        Partial Sums"
tmsce-authors:
  - name: "J. Smith"
    superscript: "1"
  - name: "A. Jones"
    superscript: "2"
tmsce-affiliations:
  - superscript: "1"
    text: "Dept. of Mathematics, ..."
  - superscript: "2"
    text: "Dept. of Applied Sciences, ..."
doi: "https://doi.org/10.0000/..."
keywords: "Fourier series, ..."
received: "15 January 2026"
accepted: "20 February 2026"
```

Features: DOI link, corresponding author email, keywords with date stamps, numbered equations, syntax-highlighted code, bibliography.

[Source](examples/demo-tmsce.md) | [PDF](examples/demo-tmsce.pdf)

</td>
<td width="50%">

![TMSCE output](media/examples/demo-tmsce.png)

</td>
</tr></table>

---

### Ludus Academik

Themed two-column layout with color-coded section headers and journal branding.

<table><tr>
<td width="50%">

```yaml
template: ludus
classoption: [red, fullpaper]
title: "Procedural Content Generation
        in Digital Narratives"
shorttitle: "Procedural Content ..."
ludus-authors:
  - name: "John Smith"
    superscript: "1"
  - name: "Alice Jones"
    superscript: "2"
journalname: "LUDUS"
publicationyear: "2026"
articledoi: "10.1234/ludus.2026.demo"
acknowledgments: |
  The authors thank ...
```

Features: theme selection (`red`, `blue`, `green`, `orange`), article type (`fullpaper`, `shortpaper`), branded header with journal name and DOI, colored section headings, acknowledgments block.

[Source](examples/demo-ludus.md) | [PDF](examples/demo-ludus.pdf)

</td>
<td width="50%">

![Ludus Academik output](media/examples/demo-ludus.png)

</td>
</tr></table>

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| New Project | | Scaffold an Inkwell project |
| Open Preview | `Cmd+Shift+V` | Live HTML, PDF, and log tabs |
| Compile PDF | `Cmd+Shift+R` | Pandoc + XeLaTeX/pdfLaTeX (per template) |
| Run Code Blocks | `Cmd+Shift+B` | Execute blocks, cache results |
| Cancel Run | | Stop in-progress execution |
| Clear Cache | | Force all blocks to re-run |
| Export PDF | | Save PDF to a specific file |
| Select Template | | Pick from installed templates |
| Setup Python Env | | Create venv, install deps |
| Check Toolchain | | Verify or install Pandoc/XeLaTeX |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `inkwell.autoCompile` | `off` | `off`, `onSave`, or `interval` |
| `inkwell.autoCompileIntervalSeconds` | `60` | Seconds between auto-compilations |
| `inkwell.defaultCodeDisplay` | `output` | Default code block visibility |

## License

[Inkwell Source License v1.0](LICENSE). Use it freely, give credit, and if you build something better, contribute it back or share it under the same terms.
