// Message display script: asks the background for labels and renders chips (spec 11).
// Not a module; may be injected more than once into the same document.

(async () => {
  try {
    let response;
    try {
      response = await browser.runtime.sendMessage({ command: "getLabels" });
    } catch {
      return;
    }

    const labels = response?.labels;
    if (!Array.isArray(labels) || labels.length === 0 || !document.body) {
      return;
    }

    const container = document.createElement("div");
    container.className = "lc-labels";
    for (const label of labels) {
      const chip = document.createElement("span");
      chip.className = label.active ? "lc-label lc-label-active" : "lc-label";
      chip.textContent = String(label.path);
      container.append(chip);
    }

    for (const existing of document.querySelectorAll(".lc-labels")) {
      existing.remove();
    }
    document.body.prepend(container);
  } catch {
    // Errors are never shown or logged by the content script (spec 13).
  }
})();

// Keep the script's completion value structured-clonable for tabs.executeScript.
undefined;
