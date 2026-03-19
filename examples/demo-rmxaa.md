---
template: rmxaa
title: "Signal Decomposition in Stellar Light Curves"
abstract: |
  We demonstrate the RMxAA journal template compiled from markdown
  using the Inkwell extension. Fourier analysis of periodic signals
  is presented as a computational example, with figures generated
  from Python code blocks and embedded directly in the output.
  This literate programming approach produces reproducible,
  submission-ready manuscripts.
resumen: |
  Demostramos la plantilla de la revista RMxAA compilada desde
  markdown usando la extension Inkwell. Se presenta el analisis
  de Fourier de senales periodicas como ejemplo computacional,
  con figuras generadas desde bloques de codigo Python e
  integradas directamente en la salida.
keywords: "Fourier analysis, signal processing, literate programming"

# --- Class options ---
classoption:
  - 9pt                               # font size
  - twoside                           # two-sided layout

# --- Authors and affiliations ---
rmxaa-authors:
  - name: "J. Smith"
    affiliations: "1"
  - name: "A. Jones"
    affiliations: "2"
  - name: "C. Rivera"
    affiliations: "1,2"
rmxaa-affiliations:
  - id: "1"
    text: "Universidad Nacional, Instituto de Astronomia, Mexico"
  - id: "2"
    text: "State University, Department of Physics, USA"
corresponding-author: "J. Smith"
corresponding-email: "j.smith@unam.mx"

# --- Journal metadata ---
leadauthor: "Smith et al."
smalltitle: "Signal Decomposition"
vol: 100
pages: "1--6"
yearofpub: 2026
# doi: "10.0000/rmxaa.2026.001"
# startpage: 1                        # sets the starting page number
# logo: "logo.png"                    # masthead logo; omit for default
# license: "Creative Commons CC BY 4.0."

# --- Submission dates ---
received: "January 15, 2026"
accepted: "February 20, 2026"

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

# INTRODUCTION {#sec:intro}

Stellar light curve analysis often requires decomposing periodic signals into frequency components. The Fourier series provides the mathematical framework for this decomposition [@fourier1822], and modern computational tools allow rapid visualization of convergence properties.

This document demonstrates the RMxAA journal template compiled from markdown through Pandoc [@macfarlane2023] and LaTeX. Code blocks execute in place, producing figures that appear in the compiled PDF.

# FOURIER ANALYSIS {#sec:fourier}

The partial sum of a square wave's Fourier series is

\begin{equation}\label{eq:fourier}
f_n(x) = \sum_{k=1}^{n} \frac{4}{(2k-1)\pi}\sin\bigl((2k-1)x\bigr).
\end{equation}

Figure 1 shows the convergence for increasing $n$.

```{python file="scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums for n = 1, 3, 5, 9."}
```

# DATA EXAMPLE {#sec:data}

A simulated regression demonstrates inline code execution:

```{python file="scripts/scatter.py" output="scatter" caption="Bivariate scatter with OLS regression."}
```

# RESULTS

| Parameter | Value |
|-----------|------:|
| $n$       |   150 |
| $r$       | 0.894 |
| Slope     | 0.700 |

: Regression summary statistics.

# CONCLUSION

The RMxAA template compiles from markdown with the journal's native two-column layout, dual-language abstracts, and standard bibliography formatting. As demonstrated in @sec:fourier and @sec:data, Inkwell's code blocks produce embedded figures without manual export steps, following the literate programming paradigm [@knuth1984].

## References
