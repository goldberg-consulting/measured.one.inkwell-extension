# Inkwell Syntax Guide

Reference for writing Inkwell documents. Covers YAML frontmatter, code blocks, math, citations, figures, tables, and template-specific fields.

## Document structure

An Inkwell document is a markdown file with a YAML frontmatter block at the top. The frontmatter controls metadata, template selection, styling, and compilation behavior.

```yaml
---
title: "Your Title"
author: "Your Name"
template: tmsce
bibliography: references/refs.bib
inkwell:
  code-bg: "#f5f5f5"
  python-env: ./venv
---

Your markdown content starts here.
```

The `---` fences are required. Everything between them is YAML. Everything after is standard Pandoc-flavored markdown.

## Frontmatter: universal fields

These fields work with any template. They are passed through to Pandoc and the LaTeX engine.

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Document title |
| `subtitle` | string | Subtitle (default template only) |
| `author` | string or list | Author name(s). For journal templates, use the template-specific author fields instead |
| `date` | string | Date displayed on the title page |
| `template` | string | Template ID: `default`, `rmxaa`, `tmsce`, `ludus`, or a custom template name |
| `abstract` | string | Abstract text. Use `\|` for multi-line YAML |
| `keywords` | string | Keywords or key phrases |
| `bibliography` | string | Path to `.bib` file, relative to the document |
| `link-citations` | boolean | Make in-text citations clickable links to the bibliography |
| `toc` | boolean | Generate a table of contents |
| `lof` | boolean | Generate a list of figures |
| `lot` | boolean | Generate a list of tables |
| `classoption` | list | Options passed to `\documentclass[...]{}`. Template-dependent |
| `header-includes` | list | Raw LaTeX inserted into the preamble |
| `geometry` | string | Page geometry, e.g. `"margin=1in"` (default template) |
| `linestretch` | number | Line spacing multiplier. Default template uses `1.4` |
| `fontsize` | string | Base font size, e.g. `11pt`, `12pt` (default template) |
| `documentclass` | string | Override the LaTeX document class (default template only) |
| `numbersections` | boolean | Number section headings. Enabled by default |
| `linkcolor` | string | Color for internal links. Default: `RoyalBlue` |
| `citecolor` | string | Color for citation links. Default: `OliveGreen` |
| `urlcolor` | string | Color for URL links. Default: `RoyalBlue` |

### Font fields (default template, requires XeLaTeX)

| Field | Type | Description |
|-------|------|-------------|
| `mainfont` | string | Main document font |
| `sansfont` | string | Sans-serif font |
| `monofont` | string | Monospace font for code |
| `mainfontoptions` | list | OpenType options for the main font |

## Frontmatter: `inkwell` namespace

The `inkwell:` block controls Inkwell-specific styling and code execution. These are parsed by the extension, not by Pandoc.

```yaml
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  code-font-size: small
  code-rounded: true
  tables: booktabs
  table-font-size: small
  table-stripe: true
  hanging-indent: true
  columns: 2
  caption-style: above
  code-display: output
  python-env: ./venv
  r-env: ./renv
  node-env: ./node_modules
```

### Styling fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code-bg` | string | `#f8f8f8` | Background color for code blocks. Hex (`"#f5f5f5"`) or named: `light-gray`, `warm-gray`, `cool-gray`, `light-blue`, `light-yellow`, `none` |
| `code-border` | boolean | `false` | Draw a thin border around code blocks |
| `code-font-size` | string | `normalsize` | Code font size: `tiny`, `scriptsize`, `footnotesize`, `small`, `normalsize` |
| `code-rounded` | boolean | `false` | Round the corners of code block borders |
| `tables` | string | `plain` | Table style: `booktabs` (horizontal rules), `grid`, `plain` |
| `table-font-size` | string | `normalsize` | Table font size: `tiny`, `scriptsize`, `footnotesize`, `small`, `normalsize` |
| `table-stripe` | boolean | `false` | Alternating row background colors in tables |
| `hanging-indent` | boolean | `false` | Hanging indent for list items |
| `columns` | integer | `1` | Number of columns for the document body (adds `multicol`) |
| `caption-style` | string | `below` | Caption position for figures and tables: `above`, `below` |

### Code execution fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code-display` | string | `output` | Default display mode for all code blocks: `output`, `both`, `code`, `none` |
| `python-env` | string | system | Path to Python virtual environment, relative to the document |
| `r-env` | string | system | Path to R environment |
| `node-env` | string | system | Path to Node.js environment |

## Code blocks

Executable code blocks use Pandoc/Quarto-style fenced syntax with curly braces around the language identifier.

### Basic syntax

````markdown
```{python}
import numpy as np
print(f"pi = {np.pi:.4f}")
```
````

### External file

Reference a script instead of writing code inline:

````markdown
```{python file="scripts/analysis.py" output="results" caption="Analysis results."}
```
````

### Attributes

All attributes go inside the curly braces as `key="value"` pairs.

| Attribute | Type | Description |
|-----------|------|-------------|
| `file` | string | Path to an external script file, relative to the document |
| `output` | string | Name for the output artifact. Inkwell looks for a file with this name in the block's output directory. Used to match a specific generated file (e.g., a plot named `histogram.png` matches `output="histogram"`) |
| `display` | string | Override the document-level display mode for this block: `output`, `both`, `code`, `none` |
| `env` | string | Path to a virtual environment for this specific block, overriding the document-level setting |
| `caption` | string | Caption for the output figure or table in the compiled PDF |
| `label` | string | Cross-reference label. Produces `fig:label` for images or `tbl:label` for tables |

### Supported languages

| Language tag | Interpreter |
|-------------|-------------|
| `python`, `python3` | `python3 -u` |
| `r` | `Rscript` |
| `shell`, `bash`, `sh` | `bash -e` or `sh -e` |
| `node`, `javascript` | `node` |

### Display modes

| Mode | In preview | In compiled PDF |
|------|-----------|-----------------|
| `output` | Shows only the output (stdout, figures, tables) | Same |
| `both` | Shows the source code followed by output | Same |
| `code` | Shows only the source code | Same |
| `none` | Hidden entirely | Hidden entirely |

The document-level default is set by `inkwell.code-display` in frontmatter (defaults to `output` for compilation, `both` for preview). Individual blocks override with `display="..."`.

### Output handling

When a code block runs, Inkwell:

1. Executes the script in the block's output directory (`.inkwell/outputs/block_N/`)
2. Captures `stdout` and `stderr`
3. Discovers output files (images, CSVs, markdown, JSON, LaTeX)

The `output` attribute selects a specific artifact by name. Without it, all artifacts are included.

**Artifact types and rendering:**

| File type | Rendered as |
|-----------|-------------|
| `.png`, `.jpg`, `.jpeg`, `.svg`, `.pdf`, `.eps` | Image/figure with optional caption |
| `.csv` | Markdown table |
| `.json` (array of objects) | Markdown table |
| `.md`, `.markdown` | Raw markdown (passed through) |
| `.tex`, `.latex` | Raw LaTeX (passed through) |
| Other | Fenced code block |

If stdout looks like markdown (starts with `#`, `|`, `>`, `*`, `-`, or contains `![`), it is passed through as raw markdown. Otherwise it renders as a text code block.

### Environment variables available to scripts

| Variable | Value |
|----------|-------|
| `INKWELL_OUTPUT_DIR` | Absolute path to the block's output directory |
| `INKWELL_BLOCK_INDEX` | Zero-based index of the current block |

Scripts should write output files (plots, tables) to `INKWELL_OUTPUT_DIR`. For example:

```python
import os
import matplotlib.pyplot as plt

fig, ax = plt.subplots()
ax.plot([1, 2, 3], [1, 4, 9])
fig.savefig(os.path.join(os.environ["INKWELL_OUTPUT_DIR"], "quadratic.png"), dpi=150)
```

### Caching

Results cache in `.inkwell/outputs/`. Blocks only re-run when their source code changes. Use **Inkwell: Clear Code Block Cache** to force a full re-run.

## Math

Inkwell enables the `tex_math_dollars` Pandoc extension. Standard LaTeX math works in both the live preview (rendered with KaTeX) and the compiled PDF.

**Inline math:** `$E = mc^2$` renders as inline math.

**Display math:** Use double dollars or a LaTeX environment:

```markdown
$$
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
$$
```

or:

```markdown
\begin{equation}\label{eq:gauss}
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
\end{equation}
```

**Equation numbering:** Use `\begin{equation}\label{eq:name}` and reference with `\eqref{eq:name}` or `(\ref{eq:name})`.

**AMS environments:** `align`, `gather`, `cases`, `bmatrix`, and all standard AMS packages are available.

## Theorem environments (default template)

The default template provides numbered theorem environments:

```markdown
::: {.theorem}
Every bounded sequence in $\mathbb{R}^n$ has a convergent subsequence.
:::

::: {.definition}
A set $S$ is **compact** if every open cover has a finite subcover.
:::
```

Available environments: `theorem`, `lemma`, `proposition`, `corollary`, `definition`, `example`, `remark`. Theorems, lemmas, propositions, and corollaries share a counter and are numbered within sections.

## Citations and bibliography

### Setup

Point to a `.bib` file in frontmatter:

```yaml
bibliography: references/refs.bib
link-citations: true
```

Inkwell runs `--citeproc` automatically. You can also place `.bib` files in the project root; Inkwell discovers them and passes them to Pandoc.

### Syntax

| Syntax | Rendered as |
|--------|-------------|
| `[@knuth1984]` | (Knuth, 1984) |
| `[@knuth1984; @fourier1822]` | (Knuth, 1984; Fourier, 1822) |
| `@knuth1984` | Knuth (1984) |
| `[-@knuth1984]` | (1984) |
| `[@knuth1984, p. 42]` | (Knuth, 1984, p. 42) |

### Bibliography placement

The bibliography renders wherever you place a `## References` heading, or at the end of the document if no such heading exists.

## Cross-references

If `pandoc-crossref` is installed, Inkwell uses it automatically.

**Figures:** `![Caption text](path/to/image.png){#fig:label}` and reference with `@fig:label`.

**Tables:** Add a caption below the table: `: Caption text {#tbl:label}` and reference with `@tbl:label`.

**Equations:** Use `\label{eq:name}` inside a LaTeX equation environment and reference with `@eq:name`.

**Sections:** Reference with `@sec:label` if the heading has `{#sec:label}`.

Without `pandoc-crossref`, use standard LaTeX references: `\ref{fig:label}`, `\eqref{eq:name}`.

## Images and figures

Standard markdown images become LaTeX figures:

```markdown
![Caption for the figure.](figures/diagram.png){width=80%}
```

Pandoc's `implicit_figures` extension is enabled, so any image alone in a paragraph becomes a figure with a caption.

Supported formats: `.png`, `.jpg`, `.jpeg`, `.svg`, `.pdf`, `.eps`.

### Attributes

Image attributes use Pandoc's `link_attributes` extension:

```markdown
![Caption](image.png){width=50% height=3in}
```

## Tables

Standard Pandoc pipe tables:

```markdown
| Method | Accuracy | Runtime |
|--------|----------|---------|
| OLS    | 0.87     | 1.2s    |
| Ridge  | 0.89     | 1.4s    |
| Lasso  | 0.85     | 1.1s    |
```

With `inkwell.tables: booktabs` in frontmatter, tables render with horizontal rules (no vertical lines). The `table-font-size` and `table-stripe` options also apply.

## Raw LaTeX

The `raw_tex` extension is enabled. You can use LaTeX commands directly in your markdown:

```markdown
This is \textbf{bold via LaTeX} and here is a forced page break:

\newpage

Or a custom environment:

\begin{center}
Centered text via LaTeX.
\end{center}
```

For blocks of raw LaTeX that should not be interpreted as markdown:

````markdown
```{=latex}
\begin{tikzpicture}
  \draw (0,0) -- (1,1);
\end{tikzpicture}
```
````

## Pandoc extensions enabled

Inkwell compiles with these Pandoc markdown extensions active:

`raw_tex`, `raw_attribute`, `tex_math_dollars`, `citations`, `footnotes`, `yaml_metadata_block`, `implicit_figures`, `link_attributes`, `fenced_divs`, `bracketed_spans`, `pipe_tables`, `smart`

This means curly quotes, em-dashes from `--`, ellipses from `...`, footnotes via `[^1]`, and fenced divs via `::: {.class}` all work.

## Template-specific frontmatter

### Inkwell Default

Template ID: `default` (or omit the `template` field).
Engine: XeLaTeX.

Uses the standard `article` class. Supports all universal fields directly. The title page, abstract, table of contents, and theorem environments are all driven from frontmatter.

```yaml
---
title: "Paper Title"
author: "Author Name"
date: "February 2026"
linestretch: 1.4
geometry: "margin=1in"
toc: true
lof: true
bibliography: references/refs.bib
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  tables: booktabs
---
```

### RMxAA

Template ID: `rmxaa`.
Engine: pdfLaTeX.

Revista Mexicana de Astronomia y Astrofisica (v4.6). Two-column journal with dual-language abstracts.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `rmxaa-authors` | list | yes | Authors with affiliation IDs |
| `rmxaa-authors[].name` | string | yes | Author name |
| `rmxaa-authors[].affiliations` | string | yes | Comma-separated affiliation IDs (e.g. `"1,2"`) |
| `rmxaa-affiliations` | list | yes | Affiliation definitions |
| `rmxaa-affiliations[].id` | string | yes | Affiliation number |
| `rmxaa-affiliations[].text` | string | yes | Institution text |
| `leadauthor` | string | no | Running header author (e.g. "Smith et al.") |
| `smalltitle` | string | no | Short title for running header |
| `corresponding-author` | string | no | Corresponding author name |
| `corresponding-email` | string | no | Corresponding author email |
| `resumen` | string | no | Spanish-language abstract |
| `vol` | integer | no | Volume number |
| `pages` | string | no | Page range (e.g. `"1--6"`) |
| `yearofpub` | integer | no | Publication year |
| `startpage` | integer | no | Starting page number |
| `received` | string | no | Received date |
| `accepted` | string | no | Accepted date |
| `license` | string | no | License text |
| `doi` | string | no | DOI |

```yaml
---
template: rmxaa
classoption: [9pt, twoside]
title: "Signal Decomposition in Stellar Light Curves"
rmxaa-authors:
  - name: "J. Smith"
    affiliations: "1"
  - name: "A. Jones"
    affiliations: "2"
rmxaa-affiliations:
  - id: "1"
    text: "Universidad Nacional, Instituto de Astronomia, Mexico"
  - id: "2"
    text: "State University, Department of Physics, USA"
leadauthor: "Smith et al."
smalltitle: "Signal Decomposition"
corresponding-author: "J. Smith"
corresponding-email: "j.smith@unam.mx"
abstract: |
  English abstract text here.
resumen: |
  Spanish abstract text here.
keywords: "Fourier analysis, signal processing"
vol: 100
received: "January 15, 2026"
accepted: "February 20, 2026"
bibliography: references/refs.bib
---
```

### TMSCE

Template ID: `tmsce`.
Engine: pdfLaTeX.

Transactions on Mathematical Sciences and Computational Engineering. Single-column journal with DOI and date stamps.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tmsce-authors` | list | yes | Authors with superscripts |
| `tmsce-authors[].name` | string | yes | Author name |
| `tmsce-authors[].superscript` | string | yes | Superscript for affiliation mapping |
| `tmsce-affiliations` | list | yes | Affiliation definitions |
| `tmsce-affiliations[].superscript` | string | yes | Matching superscript |
| `tmsce-affiliations[].text` | string | yes | Institution text |
| `corresponding-email` | string | no | Corresponding author email |
| `doi` | string | no | DOI URL |
| `copyrightline` | string | no | Copyright notice |
| `permissions` | string | no | Permissions text |
| `vol` | integer | no | Volume number |
| `issue` | integer | no | Issue number |
| `yearofpub` | integer | no | Publication year |
| `pagerange` | string | no | Page range (e.g. `"1--8"`) |
| `received` | string | no | Received date |
| `revised` | string | no | Revised date |
| `accepted` | string | no | Accepted date |

```yaml
---
template: tmsce
title: "On the Convergence of Fourier Partial Sums"
tmsce-authors:
  - name: "J. Smith"
    superscript: "1"
  - name: "A. Jones"
    superscript: "2"
tmsce-affiliations:
  - superscript: "1"
    text: "Department of Mathematics, State University, USA"
  - superscript: "2"
    text: "Department of Applied Sciences, Tech Institute, UK"
corresponding-email: "j.smith@stateuniv.edu"
abstract: |
  Abstract text here.
keywords: "Fourier series; convergence; literate programming"
doi: "10.0000/tmsce.2026.042"
vol: 1
issue: 1
received: "15 January 2026"
accepted: "20 February 2026"
bibliography: references/refs.bib
---
```

### Ludus Academik

Template ID: `ludus`.
Engine: XeLaTeX.

Themed two-column journal with color-coded headers.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `classoption` | list | yes | Theme and article type. Theme: `red`, `blue`, `green`, `orange`. Type: `fullpaper`, `shortpaper` |
| `ludus-authors` | list | yes | Authors with superscripts |
| `ludus-authors[].name` | string | yes | Author name |
| `ludus-authors[].superscript` | string | yes | Superscript for affiliation mapping |
| `ludus-affiliations` | list | yes | Affiliation definitions |
| `ludus-affiliations[].superscript` | string | yes | Matching superscript |
| `ludus-affiliations[].text` | string | yes | Institution text |
| `corresponding-email` | string | no | Corresponding author email |
| `shorttitle` | string | no | Short title for running header |
| `shortauthor` | string | no | Short author for running header |
| `journalname` | string | no | Journal name in header |
| `journalsubtitle` | string | no | Journal subtitle |
| `conferencename` | string | no | Conference name (if applicable) |
| `publicationyear` | integer | no | Publication year |
| `articledoi` | string | no | DOI |
| `acknowledgments` | string | no | Acknowledgments section (rendered at end of document) |

```yaml
---
template: ludus
classoption: [red, fullpaper]
title: "Procedural Content Generation in Digital Narratives"
shorttitle: "Procedural Content in Digital Narratives"
shortauthor: "Smith & Jones"
ludus-authors:
  - name: "John Smith"
    superscript: "1"
  - name: "Alice Jones"
    superscript: "2"
ludus-affiliations:
  - superscript: "1"
    text: "Department of Computer Science, State University, USA"
  - superscript: "2"
    text: "School of Digital Media, Tech Institute, UK"
corresponding-email: "john.smith@stateuniv.edu"
journalname: "LUDUS"
publicationyear: 2026
articledoi: "10.1234/ludus.2026.demo"
abstract: |
  Abstract text here.
keywords: "literate programming; reproducible research"
acknowledgments: |
  The authors thank the reviewers.
bibliography: references/refs.bib
---
```

## Project configuration

An Inkwell project is a directory containing `.inkwell/manifest.json`. This file stores project-level settings.

```json
{
  "template": "tmsce"
}
```

The template in `manifest.json` is used when no `template` field is present in the document's frontmatter.

### Manifest fields

| Field | Type | Description |
|-------|------|-------------|
| `template` | string | Default template for documents in this project |
| `name` | string | Project name |
| `documentSettings.fontSize` | number | Base font size |
| `documentSettings.lineSpacing` | number | Line spacing |
| `documentSettings.paperSize` | string | Paper size |
| `documentSettings.fontFamily` | string | Font family |

### Project directory layout

```
my-paper/
  my-paper.md
  scripts/
  figures/
  references/refs.bib
  requirements.txt
  venv/
  .inkwell/
    manifest.json
    outputs/          (generated, gitignored)
  .gitignore
```

### `defaults.yaml`

If a `defaults.yaml` file exists in the project root, Inkwell passes it to Pandoc via `--defaults`. This lets you set any Pandoc options without frontmatter:

```yaml
pdf-engine: xelatex
variables:
  geometry: "margin=1in"
```

## Compilable file types

Inkwell compiles these file types:

| Extension | Compilation path |
|-----------|-----------------|
| `.md`, `.markdown`, `.txt` | Pandoc (markdown to PDF) |
| `.rst` | Pandoc (reStructuredText to PDF) |
| `.org` | Pandoc (Org-mode to PDF) |
| `.tex`, `.latex` | Direct XeLaTeX (two passes, plus biber/bibtex if needed) |

## Quick reference

### Minimal document

```yaml
---
title: "My Paper"
author: "Name"
bibliography: refs.bib
---

# Introduction

Write here. Cite with [@key]. Math with $x^2$.
```

### Full-featured document

```yaml
---
template: tmsce
title: "Full Example"
tmsce-authors:
  - name: "A. Author"
    superscript: "1"
tmsce-affiliations:
  - superscript: "1"
    text: "University, Department, Country"
abstract: |
  Abstract paragraph.
keywords: "keyword1; keyword2"
doi: "10.0000/example"
received: "1 January 2026"
accepted: "1 February 2026"
bibliography: references/refs.bib
link-citations: true
toc: true
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  code-font-size: small
  tables: booktabs
  table-font-size: small
  code-display: output
  python-env: ./venv
---

# Introduction

Text with citation [@key].

## Methods

Inline math $\alpha = 0.05$ and display math:

$$
\hat{\beta} = (X^T X)^{-1} X^T y
$$

```{python file="scripts/analysis.py" output="results" caption="Regression results." label="regression"}
```

See @fig:regression for the output.

# Results

```{python display="both"}
import numpy as np
print(f"Mean: {np.mean([1,2,3]):.2f}")
```

## References
```
