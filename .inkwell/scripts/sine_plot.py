import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 500)
fig, ax = plt.subplots(figsize=(6, 3))
for n in [1, 3, 5, 9]:
    y = sum(np.sin((2*k-1)*x) / (2*k-1) for k in range(1, n+1)) * 4 / np.pi
    ax.plot(x, y, label=f"$n={n}$", linewidth=1.2)
ax.axhline(1, color="black", linestyle="--", linewidth=0.5, alpha=0.4)
ax.axhline(-1, color="black", linestyle="--", linewidth=0.5, alpha=0.4)
ax.set_xlabel("$x$")
ax.set_ylabel("$f_n(x)$")
ax.set_title("Fourier Partial Sums of a Square Wave")
ax.legend(fontsize=8)
ax.grid(alpha=0.2)
fig.tight_layout()

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "sine_plot.png"), dpi=200, bbox_inches="tight")
plt.close(fig)
print("Fourier partial sums generated.")
