(function () {
  "use strict";

  function renderMath() {
    if (typeof renderMathInElement === "undefined") return;
    var article = document.querySelector("article");
    if (!article) return;
    renderMathInElement(article, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\\\[", right: "\\\\]", display: true },
        { left: "\\\\(", right: "\\\\)", display: false },
      ],
      throwOnError: false,
    });
  }

  function renderMermaid() {
    document.querySelectorAll("code.language-mermaid").forEach(function (block) {
      var pre = block.parentElement;
      if (!pre) return;
      var div = document.createElement("div");
      div.className = "mermaid";
      div.textContent = block.textContent;
      pre.parentNode.replaceChild(div, pre);
    });
    if (typeof mermaid !== "undefined") {
      var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      mermaid.initialize({
        startOnLoad: true,
        theme: isDark ? "dark" : "default",
      });
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderMath();
    renderMermaid();
  });
})();
