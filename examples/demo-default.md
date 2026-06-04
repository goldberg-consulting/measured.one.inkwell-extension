---
title: "Inkwell Default Template Demo"
author: "Inkwell"
date: "February 2026"
toc: true
lof: true
lot: true
bibliography: .inkwell/references/refs.bib
link-citations: true
figPrefix: "Figure"
tblPrefix: "Table"
eqnPrefix: "Equation"
secPrefix: "Section"
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  code-rounded: true
  code-font-size: small
  code-display: output
  tables: booktabs
  table-font-size: small
  python-env: ./venv
---

# Overview {#sec:overview}

This document exercises the features of the Inkwell default template: a
table of contents, numbered sections and equations, runnable Python code
blocks with inline output, cross-references, citations, and a theorem
environment. It doubles as a worked example of Fourier analysis, using the
bundled scripts in `.inkwell/scripts/` to generate every figure and table.

The presentation follows the literate-programming model described by
@knuth1984, where prose and the code that produces each result live in the
same source. Pandoc performs the Markdown-to-LaTeX conversion [@macfarlane2023];
the numerical work uses NumPy [@harris2020] and Matplotlib [@hunter2007].

# Fourier Partial Sums {#sec:fourier}

A square wave of unit amplitude admits the Fourier sine series

$$
f(x) = \frac{4}{\pi} \sum_{k=1}^{\infty} \frac{\sin\!\big((2k-1)x\big)}{2k-1},
$$ {#eq:square-wave}

whose partial sums $f_n$ retain only the first $n$ odd harmonics.
@eq:square-wave converges pointwise to the square wave everywhere except at
its jump discontinuities, where the partial sums overshoot the limiting
value by a fixed proportion regardless of $n$.

::: {.theorem name="Gibbs phenomenon"}
Near a jump discontinuity, the partial sums $f_n$ of @eq:square-wave overshoot
the one-sided limit by approximately $8.9\%$ of the jump height, and this
overshoot does not vanish as $n \to \infty$; it merely narrows toward the
discontinuity.
:::

@fig:fourier shows the first four odd-harmonic partial sums approaching the
square wave, with the characteristic overshoot near each transition.

```{python file=".inkwell/scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums for n = 1, 3, 5, 9 converging to a square wave." label="fourier"}
```

The convergence is quantified in @tbl:convergence, which reports the partial
sum at $x = \pi/2$, the absolute error against the limit, and the peak
overshoot as the number of terms increases.

```{python file=".inkwell/scripts/convergence_table.py" output="convergence" caption="Convergence of Fourier partial sums at x = pi/2." label="convergence"}
```

# A Regression Aside {#sec:regression}

To exercise the figure pipeline a second time, @fig:scatter fits an ordinary
least squares line to simulated bivariate data.

```{python file=".inkwell/scripts/scatter.py" output="scatter" caption="Simulated bivariate data with an ordinary least squares fit." label="scatter"}
```

# Compilation Pipeline {#sec:pipeline}

@fig:pipeline sketches how Inkwell turns this Markdown source into a PDF: code
blocks run first and cache their output, the cached results are injected back
into the document, and Pandoc hands the assembled source to the TeX engine.

```{mermaid caption="Inkwell compilation pipeline." label="pipeline"}
flowchart LR
    MD[Markdown source] --> RUN[Run code blocks]
    RUN --> CACHE[(Cached output)]
    CACHE --> INJECT[Inject results]
    MD --> INJECT
    INJECT --> PANDOC[Pandoc]
    PANDOC --> ENGINE[XeLaTeX]
    ENGINE --> PDF[(PDF)]
```

# References
