---
template: eth-report
title: "Signal Decomposition Methods for Urban Traffic Flow Analysis"
subtitle: "A Computational Approach"
papertype: "Working Paper 1042"
headingstitle: "Signal Decomposition in Traffic Flow"
eth-authors:
  - name: "Joseph Molloy"
    department: "IVT"
    institution: "ETH Zürich"
    address: "CH-8093 Zurich"
    email: "joseph.molloy@ivt.baug.ethz.ch"
  - name: "Second Author"
    department: "IVT"
    institution: "ETH Zürich"
reportdate: "March 2026"
reportnumber: "1042"
abstract: |
  This working paper demonstrates the ETH IVT report template
  within the Inkwell extension. We present computational examples
  that generate figures directly from markdown, combining
  mathematical analysis with reproducible output.
  The single-column layout, title page, and bibliography
  are all produced from YAML frontmatter and Pandoc compilation.
keywords: "traffic simulation; Fourier analysis; reproducible research"
suggestedcitation: "Molloy, J. and Author, S. (2026) Signal Decomposition Methods for Urban Traffic Flow Analysis. Working Paper 1042, IVT, ETH Zürich."

toc: true
lot: true
lof: true

bibliography: references/refs.bib
link-citations: true

figPrefix: "Figure"
tblPrefix: "Table"
eqnPrefix: "Equation"
secPrefix: "Section"

inkwell:
  code-display: output
  code-bg: "#f5f5f5"
  code-border: true
  code-font-size: small
  tables: booktabs
  python-env: ./venv
---

# Introduction {#sec:intro}

Transport simulation requires precise signal decomposition methods to analyze periodic traffic flow patterns. This working paper demonstrates the ETH IVT report template within the Inkwell extension, combining computational examples with academic writing.

The literate programming paradigm [@knuth1984] allows code and prose to coexist. Inkwell extends this to compiled PDF output: code blocks execute, and their results (figures, tables, text) appear in the final document. Pandoc [@macfarlane2023] handles the conversion from markdown to LaTeX.

# Mathematical Framework {#sec:math}

The Fourier partial sum approximating a square wave is given by @eq:fourier:

$$f_n(x) = \sum_{k=1}^{n} \frac{4}{(2k-1)\pi}\sin\bigl((2k-1)x\bigr)$$ {#eq:fourier}

As $n \to \infty$, the partial sums converge pointwise to the square wave at all points of continuity. The overshoot near discontinuities is the Gibbs phenomenon, which persists at approximately 9% of the jump regardless of the number of terms.

# Computational Results {#sec:results}

@Fig:fourier shows the Fourier partial sums converging to the square wave as $n$ increases.

```{python file="scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums converging to a square wave." label="fourier"}
```

@Fig:scatter presents a simulated scatter plot with linear regression, demonstrating the integration of Python-generated figures.

```{python file="scripts/scatter.py" output="scatter" caption="Scatter plot with linear regression." label="scatter"}
```

# Discussion {#sec:discussion}

The examples in @sec:results demonstrate that Inkwell produces publication-quality figures from Python scripts. @Eq:fourier in @sec:math confirms that LaTeX math compiles correctly within the ETH report layout. The single-column format with the IVT title page provides a clean working paper presentation.

NumPy [@harris2020] and Matplotlib [@hunter2007] provide the computational foundation for the visualizations shown in @Fig:fourier and @Fig:scatter.

## References
