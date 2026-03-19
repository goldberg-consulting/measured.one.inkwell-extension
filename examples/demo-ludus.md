---
template: ludus
title: "Procedural Content Generation in Digital Narratives"
abstract: |
  This paper demonstrates the Ludus Academik journal template
  within the Inkwell extension. We present computational examples
  that generate figures directly from markdown, combining
  mathematical analysis with reproducible output.
  The two-column layout, themed headers, and bibliography
  are all produced from YAML frontmatter and Pandoc compilation.
keywords: "literate programming; reproducible research; Pandoc; LaTeX"

# --- Class options ---
classoption:
  - red                               # theme: red, blue, green, orange
  - fullpaper                         # type: fullpaper, shortpaper

# --- Authors and affiliations ---
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

# --- Header and running head ---
shorttitle: "Procedural Content in Digital Narratives"
shortauthor: "Smith & Jones"

# --- Journal metadata ---
journalname: "LUDUS"
journalsubtitle: "International Journal of Game Studies"
# conferencename: "GameSci 2026"     # for conference proceedings
publicationyear: 2026
articledoi: "10.1234/ludus.2026.demo"
# logo: "logo.png"                    # journal or conference logo

# --- End matter ---
acknowledgments: |
  The authors thank the Inkwell contributors for the template system.

# --- Layout options ---
linenumbers: false                    # line numbers in the margin
# toc: true                           # table of contents
# lof: true                           # list of figures
# lot: true                           # list of tables

# --- Bibliography ---
bibliography: references/refs.bib
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
  python-env: ./venv
---

# Introduction {#sec:intro}

Academic publishing requires precise formatting that varies by journal. Inkwell addresses this by compiling markdown to journal-specific LaTeX classes through Pandoc [@macfarlane2023]. This document uses the Ludus Academik template, producing a two-column layout with themed section headers.

The literate programming paradigm [@knuth1984] allows code and prose to coexist. Inkwell extends this to compiled PDF output: code blocks execute, and their results (figures, tables, text) appear in the final document.

# Computational Example {#sec:computation}

We demonstrate with a Fourier series visualization [@fourier1822]. The partial sum approximating a square wave is given by @eq:fourier.

$$f_n(x) = \sum_{k=1}^{n} \frac{4}{(2k-1)\pi}\sin\bigl((2k-1)x\bigr)$$ {#eq:fourier}

@Fig:fourier shows the partial sums converging to the square wave as $n$ increases. The overshoot at the discontinuity is the Gibbs phenomenon.

```{python file="scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums converging to a square wave." label="fourier"}
```

# Data Visualization {#sec:dataviz}

@Fig:scatter shows a simulated scatter plot with linear regression, generated inline by Python.

```{python file="scripts/scatter.py" output="scatter" caption="Simulated regression with n = 150 data points." label="scatter"}
```

# Results {#sec:results}

@Tbl:convergence shows the convergence behavior of the Fourier partial sums at the midpoint $x = \pi/2$, where the true value is $f(x) = 1$. The peak overshoot column quantifies the Gibbs phenomenon: regardless of $n$, the maximum value overshoots by approximately 9% of the jump magnitude.

```{python file="scripts/convergence_table.py" output="convergence" caption="Convergence of Fourier partial sums at x = pi/2." label="convergence"}
```

# Conclusion

The regression in @Fig:scatter was fitted to $n = {{sample_n}}$ observations, yielding $r = {{corr_r}}$ and $\hat\beta = `{python} f"{float(slope):.2f}"`$. As shown in @Fig:fourier and @Fig:scatter, Inkwell produces publication-quality figures from Python scripts. @Tbl:convergence in @sec:results demonstrates CSV-to-table rendering, and @Eq:fourier in @sec:computation confirms that LaTeX math compiles correctly. The Ludus template handles all of these in a two-column layout with themed headers and bibliography.

## References
