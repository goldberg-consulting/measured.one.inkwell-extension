# Inkwell

![Inkwell: Markdown to Publication-Quality PDF](media/hero-banner.png)

Inkwell lets you stay in markdown, stay in your editor, and still get publication-quality PDFs out the other end. Your analysis scripts run in place, their outputs land in the document, and the whole thing compiles to LaTeX without you ever opening a `.tex` file. Or open one. It handles those too.

## How it works

![Write, Run, Compile, PDF](media/workflow.png)

1. **Write** in markdown with YAML frontmatter for metadata and styling
2. **Run** code blocks (Python, R, Shell, Node) that produce figures, tables, and text
3. **Compile** through Pandoc and XeLaTeX with your chosen journal template
4. **PDF** output with embedded results, citations, and formatted math

![Editor with live PDF preview](media/editor-preview.png)

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

Inkwell needs Pandoc and XeLaTeX installed on your system. On first activation, it checks for both and offers guided installation if either is missing.

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

Inkwell ships with four templates. Each journal template includes a Pandoc `.latex` wrapper that compiles with the journal's native document class.

| Template | Class | Description |
|----------|-------|-------------|
| **Inkwell Default** | `article` | Clean article with theorem environments, code highlighting, title page |
| **TMSCE** | `tmsce` | Transactions on Mathematical Sciences and Computational Engineering |
| **Ludus Academik** | `ludusofficial` | Ludus Academik Journal (themed, two-column) |
| **RMxAA** | `rmaa-rho` | Revista Mexicana de Astronomia y Astrofisica (v4.6, two-column) |

Select a template with `template: tmsce` in your YAML frontmatter, or use `Cmd+Shift+P` > **Inkwell: Select LaTeX Template**.

Journal-specific metadata (DOI, volume, issue, author affiliations, received/accepted dates) is set through YAML frontmatter. See the example files in [`examples/`](examples/) for complete working documents with each template.

### Custom templates

Add your own by dropping a template directory (with a `template.json` manifest and a `.latex` Pandoc template) into `~/.inkwell/templates/`. Any Overleaf or journal template works. Project-local templates go in `.inkwell/templates/` within your project.

## Examples

The [`examples/`](examples/) directory contains working demo documents for each template:

| File | Template | Features demonstrated |
|------|----------|----------------------|
| [`demo-default.md`](examples/demo-default.md) | Inkwell Default | Code blocks, figures, citations, math, TOC |
| [`demo-tmsce.md`](examples/demo-tmsce.md) | TMSCE | Journal metadata, author affiliations, keywords |
| [`demo-ludus.md`](examples/demo-ludus.md) | Ludus Academik | Two-column layout, themed headers, acknowledgments |
| [`demo-rmxaa.md`](examples/demo-rmxaa.md) | RMxAA | Dual-language abstracts, astronomy formatting |

To try them:

```bash
cd examples
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Then open any `.md` file, hit **Run**, then **Compile**.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| New Project | | Scaffold an Inkwell project |
| Open Preview | `Cmd+Shift+V` | Live HTML, PDF, and log tabs |
| Compile PDF | `Cmd+Shift+R` | Pandoc + XeLaTeX |
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

MIT
