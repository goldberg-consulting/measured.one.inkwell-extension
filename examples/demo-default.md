---
title: "Inkwell Default Template Demo"
author: "Inkwell"
date: "February 2026"
toc: true
bibliography: .inkwell/references/refs.bib
link-citations: true
figPrefix: "Figure"
tblPrefix: "Table"
eqnPrefix: "Equation"
secPrefix: "Section"
inkwell:
  code-bg: "#f5f5f5"
  code-display: output
  tables: booktabs
  python-env: ./venv
---

# Introduction {#sec:intro}

This is a minimal example for the Inkwell default template. It shows the
features most documents actually use: headings, prose, inline and display
math, a figure and a table generated from code, and citations. The
literate-programming approach, where prose and the code that produces each
result live together, follows @knuth1984. Pandoc handles the
Markdown-to-LaTeX conversion [@macfarlane2023].

Inline math such as $e^{i\pi} + 1 = 0$ sits in the text, while display math
is set on its own line and can be cross-referenced:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
$$ {#eq:gaussian}

@eq:gaussian is the Gaussian integral.

# A Figure {#sec:figure}

@fig:sine plots the first few odd-harmonic partial sums of a square wave,
produced with NumPy [@harris2020] and Matplotlib [@hunter2007].

```{python file=".inkwell/scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums for n = 1, 3, 5, 9." label="sine"}
```

# A Table {#sec:table}

@tbl:convergence reports how the partial sums converge at $x = \pi/2$ as the
number of terms increases.

```{python file=".inkwell/scripts/convergence_table.py" output="convergence" caption="Convergence of the partial sums at x = pi/2." label="convergence"}
```

# References
