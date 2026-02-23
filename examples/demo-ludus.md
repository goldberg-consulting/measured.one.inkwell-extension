---
template: ludus
classoption:
  - red
  - fullpaper
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
journalsubtitle: "International Journal of Game Studies"
publicationyear: 2026
articledoi: "10.1234/ludus.2026.demo"
abstract: |
  This paper demonstrates the Ludus Academik journal template
  within the Inkwell extension. We present computational examples
  that generate figures directly from markdown, combining
  mathematical analysis with reproducible output.
  The two-column layout, themed headers, and bibliography
  are all produced from YAML frontmatter and Pandoc compilation.
keywords: "literate programming; reproducible research; Pandoc; LaTeX"
acknowledgments: |
  The authors thank the Inkwell contributors for the template system.
bibliography: references/refs.bib
link-citations: true
inkwell:
  code-display: output
  python-env: ./venv
---

# Introduction

Academic publishing requires precise formatting that varies by journal. Inkwell addresses this by compiling markdown to journal-specific LaTeX classes through Pandoc [@macfarlane2023]. This document uses the Ludus Academik template, producing a two-column layout with themed section headers.

The literate programming paradigm [@knuth1984] allows code and prose to coexist. Inkwell extends this to compiled PDF output: code blocks execute, and their results (figures, tables, text) appear in the final document.

# Computational Example

We demonstrate with a Fourier series visualization [@fourier1822]. The partial sum approximating a square wave is given by @eq:fourier.

$$f_n(x) = \sum_{k=1}^{n} \frac{4}{(2k-1)\pi}\sin\bigl((2k-1)x\bigr)$$ {#eq:fourier}

@fig:fourier shows the partial sums converging to the square wave as $n$ increases. The overshoot at the discontinuity is the Gibbs phenomenon.

```{python file="scripts/sine_plot.py" output="sine_plot" caption="Fourier partial sums converging to a square wave." label="fourier"}
```

# Data Visualization

@fig:scatter shows a simulated scatter plot with linear regression, generated inline by Python.

```{python file="scripts/scatter.py" output="scatter" caption="Simulated regression with n = 150 data points." label="scatter"}
```

# Results

@tbl:convergence shows the convergence behavior of the Fourier partial sums at the midpoint $x = \pi/2$, where the true value is $f(x) = 1$. The peak overshoot column quantifies the Gibbs phenomenon: regardless of $n$, the maximum value overshoots by approximately 9% of the jump magnitude.

```{python file="scripts/convergence_table.py" output="convergence" caption="Convergence of Fourier partial sums at x = pi/2." label="convergence"}
```

# Conclusion

As shown in @fig:fourier and @fig:scatter, Inkwell produces publication-quality figures from Python scripts. @tbl:convergence demonstrates CSV-to-table rendering, and @eq:fourier confirms that LaTeX math compiles correctly. The Ludus template handles all of these in a two-column layout with themed headers and bibliography.

## References
