---
template: rho
title: "Template for preparing an academic article using the Rho LaTeX class with Inkwell"
abstract: |
  This document demonstrates the Rho LaTeX class rendered through
  Inkwell's Pandoc pipeline. Rho provides a two-column academic
  article layout with colored section headers, a styled abstract box,
  corresponding-author metadata, and footer fields. All of these are
  controlled from YAML frontmatter: no LaTeX editing required.
keywords: "Inkwell, Pandoc, Rho class, academic template, reproducible documents"

# --- Class options ---
# classoption:                        # default: 9pt, a4paper, twoside
#   - 10pt
#   - letterpaper

# --- Authors and affiliations ---
rho-authors:
  - name: "Author One"
    superscript: "1,*"
  - name: "Author Two"
    superscript: "2"
  - name: "Author Three"
    superscript: "3,*"
rho-affiliations:
  - superscript: "1"
    text: "Affiliation of author one"
  - superscript: "2"
    text: "Affiliation of author two"
  - superscript: "3"
    text: "Affiliation of author three"
  - superscript: "*"
    text: "These authors contributed equally to this work"

# --- Journal and header metadata ---
journalname: "Rho Journal"
smalltitle: "Rho Template"
leadauthor: "Author et al."
institution: "University Name"
dates: "This manuscript was compiled on February 22, 2026"
theday: "February 22, 2026"
footinfo: "Creative Commons CC BY 4.0"
logo: "logo.png"                      # path to masthead logo; set to false to suppress

# --- Corresponding author block ---
corres: "Provide the corresponding author information here."
email: "example@organization.com"
doi: "https://www.doi.org/exampledoi/XXXXXXXXXX"
received: "January 10, 2026"
revised: "February 1, 2026"
accepted: "February 15, 2026"
published: "February 22, 2026"
license: "This document is licensed under Creative Commons CC BY 4.0."

# --- Layout options ---
linenumbers: false                    # line numbers in the margin
# toc: true                           # table of contents
# lof: true                           # list of figures
# lot: true                           # list of tables

# --- Bibliography ---
bibliography: .inkwell/references/refs.bib
link-citations: true

# --- Cross-reference prefixes ---
figPrefix: "figure"
tblPrefix: "table"
eqnPrefix: "equation"
secPrefix: "section"

# --- Custom LaTeX in the preamble ---
# header-includes: |
#   \usepackage{tikz}

# --- Inkwell styling ---
inkwell:
  code-display: output                # default display: output, both, code, none
  # code-bg: "#f5f5f5"
  # code-border: true
  # code-font-size: small
  # tables: booktabs                  # booktabs, grid, plain
  # table-font-size: small
  # python-env: ./venv
---

# Introduction {#sec:intro}

The Rho LaTeX class provides a polished two-column layout for academic articles and lab reports. Originally designed for Overleaf, it is adapted here as an Inkwell template so that authors can write in markdown and produce publication-quality PDFs.

Rho's visual identity includes colored section headers, a tinted abstract box with keywords, and a corresponding-author block with dates, DOI, and license. All metadata is set in the YAML frontmatter above.

# Equations {#sec:equations}

The Schrodinger equation serves as a typesetting example:

$$\frac{\hbar^2}{2m}\nabla^2\Psi + V(\mathbf{r})\Psi = -i\hbar \frac{\partial\Psi}{\partial t}$$ {#eq:schrodinger}

@Eq:schrodinger renders through Pandoc's `tex_math_dollars` extension. The `stix2` font bundled with Rho provides high-quality mathematical symbols without additional packages.

# Code Highlighting {#sec:code}

Pandoc syntax highlighting works alongside Rho's built-in listings style. Fenced code blocks produce colored output:

```python
import numpy as np

def fourier_partial_sum(x, n_terms):
    """Compute the n-term Fourier partial sum of a square wave."""
    result = np.zeros_like(x)
    for k in range(1, n_terms + 1):
        result += (4 / ((2 * k - 1) * np.pi)) * np.sin((2 * k - 1) * x)
    return result
```

# Tables {#sec:tables}

Pandoc pipe tables compile into single-column table floats. Rho's caption style applies automatically.

| Day       | Min Temp | Max Temp | Summary                          |
|-----------|----------|----------|----------------------------------|
| Monday    | 11 C     | 22 C     | Clear skies, strong breeze       |
| Tuesday   | 9 C      | 19 C     | Cloudy with rain in the north    |
| Wednesday | 10 C     | 21 C     | Morning rain, clearing by noon   |

: Weekly forecast example. {#tbl:forecast}

# Cross-References {#sec:crossref}

Pandoc-crossref handles numbered references: @Eq:schrodinger for equations, @Tbl:forecast for tables, and @sec:equations or @sec:tables for sections. Bibliography citations [@macfarlane2023] also resolve in the compiled output. As discussed in @sec:intro, all metadata is controlled from YAML frontmatter.

# Conclusion

This demo confirms that the Rho template integrates with Inkwell's compilation pipeline. Authors write standard markdown with YAML frontmatter, and the extension produces a two-column PDF matching Rho's original LaTeX design.

## References
