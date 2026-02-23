import numpy as np
from scipy import stats

rng = np.random.default_rng(42)
B = 2000
sample_sizes = [2, 5, 15, 50]

sources = {
    "Exponential": lambda n: rng.exponential(1.0, n),
    "Uniform": lambda n: rng.uniform(0, 1, n),
    "Beta(2,5)": lambda n: rng.beta(2, 5, n),
}

header = "| Distribution | " + " | ".join(f"$n={n}$" for n in sample_sizes) + " |"
sep = "|" + "|".join(["---"] * (len(sample_sizes) + 1)) + "|"

rows = [header, sep]
for name, draw in sources.items():
    cells = [name]
    for n in sample_sizes:
        means = np.array([draw(n).mean() for _ in range(B)])
        _, p = stats.shapiro(means)
        if p < 0.001:
            cells.append("$< 0.001$")
        else:
            cells.append(f"${p:.3f}$")
    rows.append("| " + " | ".join(cells) + " |")

print("\n".join(rows))
