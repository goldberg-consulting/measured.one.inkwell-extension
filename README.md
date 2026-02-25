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

### 1. Install dependencies

**macOS (Homebrew):**

```bash
brew install pandoc
brew install --cask mactex
npm install -g @mermaid-js/mermaid-cli
```

That gives you everything: Pandoc, LaTeX (XeLaTeX + pdfLaTeX), and Mermaid diagram support.

**Smaller macOS install (~150 MB instead of ~5 GB):**

Replace `mactex` with TinyTeX if you want a minimal footprint. You will need to install LaTeX packages as Inkwell's templates require them.

```bash
brew install pandoc
curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh
npm install -g @mermaid-js/mermaid-cli
```

Then install the LaTeX packages Inkwell's templates need (listed in [`requirements-latex.txt`](requirements-latex.txt)):

```bash
sed 's/#.*//' requirements-latex.txt | xargs tlmgr install && texhash
```

**Linux:**

```bash
sudo apt install pandoc texlive-full                 # Debian/Ubuntu
sudo dnf install pandoc texlive-scheme-full          # Fedora
npm install -g @mermaid-js/mermaid-cli
```

**Python** (optional, for runnable `{python}` code blocks): set up per-project with `Cmd+Shift+P` > **Inkwell: Setup Python Environment**, or manually:

```bash
python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt
```

> **Troubleshooting:** If compilation fails with `Missing file: foo.sty`, run `tlmgr install foo`. The build log (`Cmd+Shift+U` > **Inkwell LaTeX**) shows the exact missing filename. Mermaid blocks without `mmdc` installed render in the live preview but appear as code listings in PDFs.

### 2. Install the extension

Clone and build from source:

```bash
git clone https://github.com/goldberg-consulting/measured.one.inkwell-extension.git
cd measured.one.inkwell-extension
npm install
npm run compile
```

Then install in your editor:
   - Open VS Code or Cursor
   - `Cmd+Shift+P` > **Developer: Install Extension from Location...**
   - Select the `measured.one.inkwell-extension` folder
   - Reload the window when prompted

See the **[Syntax Guide](guide.md)** for the complete reference on YAML frontmatter, code blocks, math, citations, and template-specific fields.

## Quick start

1. `Cmd+Shift+P` > **Inkwell: New Project**
2. Select a folder for your project
3. Name your document (this becomes the main `.md` filename)
4. Pick a template (Default, Tufte, Rho, TMSCE, Ludus, RMxAA, or KTH Letter)
5. Choose whether to set up a Python virtual environment (recommended if your document will have code blocks)
6. Inkwell creates the project with starter files, example scripts, bibliography, and a syntax guide at `.inkwell/guide.md`
7. Write your markdown in the generated `.md` file
8. `Cmd+Shift+B` to **Run** code blocks
9. `Cmd+Shift+R` to **Compile** to PDF
10. `Cmd+Shift+V` to open the **Preview** panel (live HTML, compiled PDF, and build log)

## Project structure

```
my-paper/
  my-paper.md              # your document
  scripts/                 # analysis code
  figures/                 # static images, diagrams
  references/              # .bib files
  examples/                # demo .md files for each template
  requirements.txt         # Python dependencies (if enabled)
  venv/                    # Python environment (if enabled)
  .inkwell/
    manifest.json          # project config (template, settings)
    guide.md               # syntax reference (frontmatter, code blocks, data binding)
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
| `cache`   | Set to `"false"` to re-run every time, skipping the content cache |

Results cache in `.inkwell/outputs/`. Only re-run when the code actually changes.

### Generated tables and figures

Code blocks that write files to `INKWELL_OUTPUT_DIR` automatically embed them in the PDF. The `output` attribute names the artifact, and the file extension determines how it renders:

- **Images** (`.png`, `.jpg`, `.svg`, `.pdf`, `.eps`) render as figures
- **CSV** files render as formatted tables with booktabs styling
- **JSON** arrays of objects render as tables
- **Markdown** (`.md`) and **LaTeX** (`.tex`) files are passed through raw

````markdown
```{python output="summary" caption="Descriptive statistics." label="stats"}
import os, numpy as np
out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
with open(os.path.join(out, "summary.csv"), "w") as f:
    f.write("Variable,n,Mean,Std\n")
    f.write("x,150,-0.05,0.85\n")
    f.write("y,150,-0.05,0.71\n")
```
````

The `caption` and `label` attributes add a numbered caption and a cross-referenceable label (`@Tbl:stats` in this case).

### Inline data binding

Code blocks can export named values that you reference later in prose, captions, or table cells. This connects your computed results to your writing so the numbers stay in sync.

**Step 1: Export values from a code block** by printing `::inkwell key=value` lines. These lines are stripped from visible output:

```python
print(f"::inkwell sample_n={len(x)}")
print(f"::inkwell corr_r={r_val:.3f}")
print(f"::inkwell slope={m:.3f}")
```

**Step 2: Reference them in your markdown** using one of two syntaxes:

| Syntax | What it does | Example |
|--------|-------------|---------|
| `{{key}}` | Inserts the raw value as-is | `{{sample_n}}` becomes `150` |
| `` `{python} expr` `` | Evaluates a Python expression with all exported variables pre-loaded | `` `{python} f"{float(corr_r):.2f}"` `` becomes `0.87` |

Use `{{key}}` for values that need no formatting (counts, labels). Use `` `{python} expr` `` when you need to format, round, or compute: f-strings, arithmetic, conditionals, and function calls all work. Variables are loaded as strings, so cast with `float()` or `int()` as needed.

```markdown
The model was fitted to {{sample_n}} observations, yielding
$r = `{python} f"{float(corr_r):.2f}"`$ and
$\hat\beta = `{python} f"{float(slope):.1f}"`$.
```

Re-run the code blocks (`Cmd+Shift+B`) after adding or changing `::inkwell` exports so the variable store picks up the new values.

### Mermaid diagrams

Fenced mermaid blocks compile to figures with full cross-reference support. The preview panel renders them client-side via mermaid.js; PDF compilation uses `mmdc` (mermaid-cli) to produce high-resolution PNG images that Pandoc embeds directly in the LaTeX output.

````markdown
```{mermaid caption="System architecture" label="arch"}
graph LR
    A[Client] --> B[API Gateway]
    B --> C[Service]
    C --> D[Database]
```
````

Reference the diagram with `@Fig:arch` anywhere in the document. Plain ` ```mermaid ` blocks (without attributes) also render, but without captions or labels. All diagram types that `mmdc` supports work: flowcharts, sequence diagrams, ER diagrams, state diagrams, Gantt charts, and more.

Rendered artifacts are cached in `.inkwell/mermaid/` by content hash. A diagram only re-renders when its source changes.

**Requirements:** `npm install -g @mermaid-js/mermaid-cli` for PDF compilation. If `mmdc` is not installed, mermaid blocks pass through as code listings.

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

Inkwell ships with seven templates. Each template includes a Pandoc `.latex` wrapper that compiles with the template's native document class. Templates declare their preferred PDF engine (`xelatex` or `pdflatex`) in `template.json`; Inkwell selects the right one automatically.

| Template | Class | Engine | Description |
|----------|-------|--------|-------------|
| **Inkwell Default** | `article` | xelatex | Clean article with theorem environments, code highlighting, title page |
| **Tufte Handout** | `tufte-handout` | pdflatex | Edward Tufte-inspired layout with wide margins, sidenotes, and margin figures |
| **Rho Academic** | `rho` | pdflatex | Two-column academic article with colored headers, abstract box, footer metadata |
| **TMSCE** | `tmsce` | pdflatex | Transactions on Mathematical Sciences and Computational Engineering |
| **Ludus Academik** | `ludusofficial` | xelatex | Ludus Academik Journal (themed, two-column) |
| **RMxAA** | `rmaa-rho` | pdflatex | Revista Mexicana de Astronomia y Astrofisica (v4.6, two-column) |
| **KTH Letter** | `kth-letter` | pdflatex | Official KTH (Royal Institute of Technology) letterhead |

Select a template with `template: tufte` in your YAML frontmatter, or use `Cmd+Shift+P` > **Inkwell: Select LaTeX Template**.

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

### Tufte Handout

Edward Tufte-inspired layout with wide margins for sidenotes, margin figures, and annotations.

<table><tr>
<td width="50%">

```yaml
template: tufte
title: "On the Principles of Analytical Display"
author: "Inkwell"
date: "February 2026"
abstract: |
  Good information design relies on showing
  the data above all else.
classoption:
  - justified
  - a4paper
bibliography: references/refs.bib
```

Features: margin notes via `::: {.aside}` divs, margin figures via raw `\begin{marginfigure}`, full-width sections via `::: {.fullwidth}`, `\newthought` for paragraph openers, Palatino typography.

[Source](examples/demo-tufte.md) | [PDF](examples/demo-tufte.pdf)

</td>
<td width="50%">

![Tufte Handout output](media/examples/demo-tufte.png)

</td>
</tr></table>

---

### KTH Letter

Official KTH (Royal Institute of Technology) letterhead with institutional logo and footer.

<table><tr>
<td width="50%">

```yaml
template: kth-letter
name: "Elis Goldberg"
email: "elis@kth.se"
web: "www.kth.se"
telephone: "+46 8 790 60 00"
dnr: "Dnr: 2026-0042"
recipient:
  - "Prof. Ada Lovelace"
  - "Department of Computing"
  - "University of London"
  - "United Kingdom"
opening: "Dear Professor Lovelace,"
closing: "Kind regards,"
```

Features: KTH branded letterhead with school logo, institutional footer with address and contact details, page numbering, recipient address block.

[Source](examples/demo-kth-letter.md) | [PDF](examples/demo-kth-letter.pdf)

</td>
<td width="50%">

![KTH Letter output](media/examples/demo-kth-letter.png)

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
journalname: "Transactions on ..."
doi: "https://doi.org/10.0000/..."
keywords: "Fourier series, ..."
received: "15 January 2026"
accepted: "20 February 2026"
```

Features: DOI link, corresponding author email, configurable journal name in footer, keywords with date stamps, numbered equations, syntax-highlighted code, bibliography.

[Source](examples/demo-tmsce.md) | [PDF](examples/demo-tmsce.pdf)

</td>
<td width="50%">

![TMSCE output](media/examples/demo-tmsce.png)

</td>
</tr></table>

---

### Rho Academic Article

Two-column academic layout with colored section headers, styled abstract box, and footer metadata.

<table><tr>
<td width="50%">

```yaml
template: rho
title: "Paper Title"
journalname: "Rho Journal"
rho-authors:
  - name: "Author One"
    superscript: "1,*"
  - name: "Author Two"
    superscript: "2"
rho-affiliations:
  - superscript: "1"
    text: "First University, ..."
  - superscript: "*"
    text: "Equal contribution"
leadauthor: "Author et al."
logo: "logo.png"
doi: "https://doi.org/10.0000/..."
received: "January 10, 2026"
accepted: "February 15, 2026"
```

Features: colored section headers, keyword box, corresponding-author block with dates/DOI/license, footer metadata, optional logo, optional line numbers.

[Source](examples/demo-rho.md) | [PDF](examples/demo-rho.pdf)

</td>
<td width="50%">

![Rho Academic output](media/examples/demo-rho.png)

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

All commands are available from the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`). Type "Inkwell" to filter.

| Command | Shortcut | Description |
|---------|----------|-------------|
| **Inkwell: New Project** | | Scaffold a project with starter files, bibliography, and example scripts |
| **Inkwell: Update Project** | | Add missing `.gitignore` entries, migrate manifest, create new starter files. Never overwrites your existing files |
| **Inkwell: Open Preview** | `Cmd+Shift+V` | Side panel with live HTML, compiled PDF, and build log tabs |
| **Inkwell: Compile PDF** | `Cmd+Shift+R` | Compile through Pandoc + XeLaTeX/pdfLaTeX (engine selected per template) |
| **Inkwell: Run Code Blocks** | `Cmd+Shift+B` | Execute all code blocks, cache results in `.inkwell/outputs/` |
| **Inkwell: Cancel Running Code Blocks** | | Stop in-progress code execution |
| **Inkwell: Clear Code Block Cache** | | Delete cached outputs so all blocks re-run on next execution |
| **Inkwell: Export PDF to File...** | | Save the compiled PDF to a chosen location |
| **Inkwell: Select LaTeX Template** | | Pick from built-in, global, or project-local templates |
| **Inkwell: Setup Python Environment** | | Create a venv and install from `requirements.txt` |
| **Inkwell: Check / Install Toolchain** | | Verify Pandoc and XeLaTeX are installed, with guided setup if missing |

**Tip:** If you are developing from source and rebuild the extension (`npm run compile`), reload the editor window with `Cmd+Shift+P` > **Developer: Reload Window** to pick up the changes.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `inkwell.autoCompile` | `off` | `off`, `onSave`, or `interval` |
| `inkwell.autoCompileIntervalSeconds` | `60` | Seconds between auto-compilations |
| `inkwell.defaultCodeDisplay` | `output` | Default code block visibility |

## Cursor AI agent

Inkwell includes a Cursor agent at `.cursor/agents/inkwell-guide.md`. When working in Cursor, invoke it with `@inkwell-guide` in chat to get help with:

- Writing YAML frontmatter for any template
- Converting LaTeX documents to Inkwell markdown
- Setting up code blocks, inline data binding, and cross-references
- Debugging compilation errors and stale caches
- Adding custom LaTeX packages via `header-includes`

The agent references the full [Syntax Guide](guide.md) for field names, attribute tables, and conversion rules.

## License

[Inkwell Source License v1.0](LICENSE). Use it freely, give credit, and if you build something better, contribute it back or share it under the same terms.
