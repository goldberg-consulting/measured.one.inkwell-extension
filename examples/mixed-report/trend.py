"""Illustrative monthly outcomes; replace outcomes.csv with your own data."""
import csv
import os
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

rows = list(csv.DictReader(Path(__file__).with_name("outcomes.csv").open()))
months = [int(row["month"]) for row in rows]
fig, ax = plt.subplots(figsize=(6.4, 3.1))
ax.plot(months, [float(row["baseline"]) for row in rows], "--", color="#7D898B", label="Baseline")
ax.plot(months, [float(row["observed"]) for row in rows], "o-", color="#267D83", label="Observed")
ax.set(xlabel="Month", ylabel="Outcome index (start = 100)", xticks=months)
ax.spines[["top", "right"]].set_visible(False)
ax.grid(axis="y", alpha=0.15)
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(Path(os.environ["INKWELL_OUTPUT_DIR"]) / "trend.png", dpi=220)
plt.close(fig)
print("Illustrative data: not a client result.")
