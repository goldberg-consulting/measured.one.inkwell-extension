---
template: tmsce
title: "Empirical Verification of the Central Limit Theorem via Monte Carlo Simulation"
tmsce-authors:
  - name: "J. Smith"
    superscript: "1"
tmsce-affiliations:
  - superscript: "1"
    text: "Department of Statistics, State University, USA"
corresponding-email: "j.smith@stateuniv.edu"
abstract: |
  We verify the central limit theorem empirically through Monte Carlo
  simulation. Sample means drawn from three non-normal distributions
  (exponential, uniform, and beta) are shown to converge to normality
  as sample size increases. Quantile-quantile plots and the
  Shapiro-Wilk test confirm the convergence. All figures and
  statistics are generated from embedded Python code, producing a
  fully reproducible analysis pipeline.
keywords: "central limit theorem; Monte Carlo simulation; convergence; reproducible research"
doi: "10.0000/tmsce.2026.demo"
vol: 1
issue: 1
yearofpub: 2026
pagerange: "1--6"
received: "10 February 2026"
revised: "18 February 2026"
accepted: "22 February 2026"
bibliography: references/refs.bib
link-citations: true
inkwell:
  code-display: output
  python-env: ./venv
---

# Introduction

The central limit theorem (CLT) states that the distribution of sample means converges to a normal distribution as sample size grows, regardless of the underlying population distribution, provided the population has finite variance [@billingsley1995]. This result underpins much of classical statistical inference and motivates the use of normal approximations in hypothesis testing and confidence interval construction.

We verify this convergence empirically by drawing repeated samples from three distinctly non-normal distributions: exponential ($\lambda = 1$), uniform on $[0, 1]$, and beta($\alpha=2, \beta=5$). For each distribution, we compute sample means at increasing sample sizes and compare the resulting distributions to a normal reference through QQ plots and the Shapiro-Wilk test [@shapiro1965].

All analysis code executes in place through Inkwell's runnable code blocks, making this document a self-contained, reproducible pipeline.

# Method

For each source distribution, we generate $B = 2{,}000$ replicate sample means at sample sizes $n \in \{2, 5, 15, 50\}$. Each replicate draws $n$ observations from the source distribution and computes the arithmetic mean. The resulting distribution of means is compared to the theoretical normal prediction:

\begin{equation}\label{eq:clt}
\bar{X}_n \xrightarrow{d} \mathcal{N}\!\left(\mu,\; \frac{\sigma^2}{n}\right)
\end{equation}

where $\mu$ and $\sigma^2$ are the population mean and variance.

# Results

## Convergence of Sample Mean Distributions

```{python file="scripts/histograms.py" output="histograms" caption="Distribution of sample means at increasing sample sizes for three non-normal populations. Dashed curves show the normal density predicted by the CLT."}
```

The histograms in Figure 1 show a clear progression from the skewed or bounded shape of the parent distribution toward the bell curve as $n$ increases. By $n = 50$, all three distributions are visually indistinguishable from normal.

## QQ Diagnostic

```{python file="scripts/qq_plots.py" output="qq_plots" caption="Normal QQ plots for the $n = 50$ sample means. Points falling on the reference line indicate agreement with normality."}
```

The QQ plots confirm that the $n = 50$ sample means align closely with the normal quantiles for all three source distributions.

## Shapiro-Wilk Test

```{python file="scripts/shapiro_table.py" output="shapiro_table" caption="Shapiro-Wilk $p$-values for normality at each sample size."}
```

Table 1 reports the Shapiro-Wilk $p$-values. At small $n$, the non-normality of the parent distribution is visible in the sample means. As $n$ grows, the $p$-values increase, reflecting the CLT convergence. The symmetric uniform converges fastest; the skewed exponential requires the largest $n$ to approach normality.

# Conclusion

The Monte Carlo analysis confirms the CLT convergence for all three non-normal source distributions. The rate of convergence depends on the skewness of the parent distribution: the symmetric uniform converges fastest, while the right-skewed exponential requires larger $n$. These results are consistent with Berry-Esseen bounds on the rate of CLT convergence [@berry1941].

This document demonstrates a complete reproducible pipeline: all figures and statistical tests are generated from embedded Python scripts, compiled through Inkwell to the TMSCE journal format. Changing any parameter (sample size, number of replicates, source distributions) and re-running produces an updated manuscript with no manual figure management.

## References
