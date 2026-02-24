---
template: rmxaa
classoption:
  - 9pt
  - twoside
title: "Signal Decomposition in Stellar Light Curves"
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
leadauthor: "Smith et al."
smalltitle: "Signal Decomposition"
corresponding-author: "J. Smith"
corresponding-email: "j.smith@unam.mx"
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
vol: 100
pages: "1--6"
yearofpub: 2026
received: "January 15, 2026"
accepted: "February 20, 2026"
linenumbers: false
# header-includes: |
#   \usepackage{xcolor}
#   \setlength{\parindent}{0pt}
bibliography: references/refs.bib
link-citations: true
figPrefix: "figure"
tblPrefix: "table"
eqnPrefix: "equation"
secPrefix: "section"
inkwell:
  code-display: output
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
