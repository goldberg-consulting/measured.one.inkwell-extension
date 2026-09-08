# Packaged editor workflow

```{shell display="both" output="summary" caption="Host result"}
sed -n '3p' workflow.md | grep -Eq 'id="[A-Za-z0-9_-]+"' || exit 41
printf 'inline-success\n'
printf 'inline-artifact\n' > "$INKWELL_OUTPUT_DIR/summary.txt"
```
