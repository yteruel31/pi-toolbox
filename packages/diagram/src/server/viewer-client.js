(() => {
  const viewport = document.getElementById("viewport");
  const sheet = document.getElementById("sheet");
  const image = document.getElementById("diagram");
  const zoomOutput = document.getElementById("zoom");
  const connection = document.querySelector(".connection");
  const connectionText = document.getElementById("connection");
  const toast = document.getElementById("toast");
  const imageUrl = new URL("./image.svg", location.href);
  const pngUrl = new URL("./image.png?scale=2", location.href);
  const eventsUrl = new URL("./events", location.href);
  let scale = 1;
  let x = 0;
  let y = 0;
  let dragging = false;
  let pointerStart;
  let toastTimer;
  const pointers = new Map();
  let pinchStart;

  const apply = () => {
    sheet.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    zoomOutput.value = `${Math.round(scale * 100)}%`;
    zoomOutput.textContent = zoomOutput.value;
  };
  const fit = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const padding = 70;
    scale = Math.min(2, (viewport.clientWidth - padding * 2) / image.naturalWidth, (viewport.clientHeight - padding * 2) / image.naturalHeight);
    scale = Math.max(.05, scale);
    x = (viewport.clientWidth - image.naturalWidth * scale) / 2;
    y = (viewport.clientHeight - image.naturalHeight * scale) / 2;
    apply();
  };
  const setScaleAt = (next, clientX, clientY) => {
    next = Math.max(.05, Math.min(8, next));
    const bounds = viewport.getBoundingClientRect();
    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;
    const diagramX = (localX - x) / scale;
    const diagramY = (localY - y) / scale;
    x = localX - diagramX * next;
    y = localY - diagramY * next;
    scale = next;
    apply();
  };
  const notify = (message) => {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 1800);
  };
  const swapImage = (revision) => {
    const next = new Image();
    const url = new URL(imageUrl);
    url.searchParams.set("rev", revision);
    next.onload = () => { image.src = url; };
    next.src = url;
  };

  image.addEventListener("load", () => { if (!image.dataset.fitted) { image.dataset.fitted = "true"; fit(); } });
  image.src = imageUrl;
  window.addEventListener("resize", fit);
  viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    setScaleAt(scale * Math.exp(-event.deltaY * .0014), event.clientX, event.clientY);
  }, { passive: false });
  viewport.addEventListener("pointerdown", (event) => {
    viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      dragging = true;
      pointerStart = { clientX: event.clientX, clientY: event.clientY, x, y };
      viewport.classList.add("dragging");
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale, centerX: (a.x + b.x) / 2, centerY: (a.y + b.y) / 2 };
    }
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      setScaleAt(pinchStart.scale * distance / Math.max(1, pinchStart.distance), pinchStart.centerX, pinchStart.centerY);
    } else if (dragging && pointerStart) {
      x = pointerStart.x + event.clientX - pointerStart.clientX;
      y = pointerStart.y + event.clientY - pointerStart.clientY;
      apply();
    }
  });
  const pointerEnd = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchStart = undefined;
    if (pointers.size === 0) {
      dragging = false;
      pointerStart = undefined;
      viewport.classList.remove("dragging");
    }
  };
  viewport.addEventListener("pointerup", pointerEnd);
  viewport.addEventListener("pointercancel", pointerEnd);

  document.getElementById("fit").addEventListener("click", fit);
  document.getElementById("actual").addEventListener("click", () => setScaleAt(1, viewport.clientWidth / 2, viewport.clientHeight / 2));
  document.getElementById("zoom-in").addEventListener("click", () => setScaleAt(scale * 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2));
  document.getElementById("zoom-out").addEventListener("click", () => setScaleAt(scale / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2));
  viewport.addEventListener("keydown", (event) => {
    if (event.key === "f") fit();
    else if (event.key === "0") setScaleAt(1, viewport.clientWidth / 2, viewport.clientHeight / 2);
    else if (event.key === "+" || event.key === "=") setScaleAt(scale * 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
    else if (event.key === "-") setScaleAt(scale / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2);
    else return;
    event.preventDefault();
  });

  for (const button of document.querySelectorAll("[data-backdrop]")) button.addEventListener("click", () => {
    viewport.classList.remove("backdrop-light", "backdrop-dark", "backdrop-grid");
    viewport.classList.add(`backdrop-${button.dataset.backdrop}`);
    for (const item of document.querySelectorAll("[data-backdrop]")) item.classList.toggle("selected", item === button);
  });

  const copyPng = document.getElementById("copy-png");
  const copySvg = document.getElementById("copy-svg");
  const canCopyImage = window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem;
  const canCopyText = window.isSecureContext && navigator.clipboard?.writeText;
  copyPng.disabled = !canCopyImage;
  copyPng.title = canCopyImage ? "Copy PNG to clipboard" : "Image copy is unavailable; use PNG download";
  copyPng.addEventListener("click", async () => {
    try {
      const blob = fetch(pngUrl).then((response) => { if (!response.ok) throw new Error(); return response.blob(); });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      notify("Image copied");
    } catch { notify("Copy failed — download the PNG instead"); }
  });
  copySvg.addEventListener("click", async () => {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error();
      const source = await response.text();
      if (canCopyText) await navigator.clipboard.writeText(source);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = source;
        textarea.setAttribute("readonly", "");
        textarea.className = "clipboard-fallback";
        document.body.append(textarea);
        textarea.select();
        if (!document.execCommand("copy")) throw new Error();
        textarea.remove();
      }
      notify("SVG copied");
    } catch { notify("Copy failed — download the SVG instead"); }
  });
  document.getElementById("download-png").href = new URL("./download.png", location.href);
  document.getElementById("download-svg").href = new URL("./download.svg", location.href);

  const stream = new EventSource(eventsUrl);
  stream.addEventListener("updated", (event) => {
    swapImage(event.data);
    connection.classList.remove("stale");
    connectionText.textContent = "Live";
  });
  stream.addEventListener("deleted", () => {
    stream.close();
    connection.classList.add("stale");
    connectionText.textContent = "Deleted";
    image.removeAttribute("src");
    notify("Diagram deleted");
  });
  stream.onopen = () => { connection.classList.remove("stale"); connectionText.textContent = "Live"; };
  stream.onerror = () => { connection.classList.add("stale"); connectionText.textContent = "Reconnecting"; };
})();
