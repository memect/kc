#!/usr/bin/env node
/**
 * PDF Review Dashboard Generator
 *
 * Generates a single self-contained HTML file with:
 * - Left: PDF viewer (pdf.js CDN, base64 embedded)
 * - Right: interactive verification results list
 * - Click result → jump to PDF page
 *
 * Usage:
 *   node generate_review.js <pdf_path> <results_json_path> [output_html_path]
 *
 * The results JSON should be an array of objects. Adapt the DATA MAPPING
 * section below to match your project's verification output format.
 */
import fs from "node:fs";
import path from "node:path";

const pdfPath = process.argv[2];
const resultsPath = process.argv[3];
const outputPath = process.argv[4] || "review_dashboard.html";

if (!pdfPath || !resultsPath) {
  console.error("Usage: node generate_review.js <pdf_path> <results_json_path> [output_html_path]");
  process.exit(1);
}

// Read inputs
const pdfBuffer = fs.readFileSync(pdfPath);
const pdfBase64 = pdfBuffer.toString("base64");
const pdfFileName = path.basename(pdfPath);
const rawResults = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));

// ============================================================
// DATA MAPPING — adapt this section to your verification output
// ============================================================
// Map your raw results into the format the dashboard expects.
// Each item needs at minimum: id, label, result, page.
// Add any extra fields you want shown in the detail panel.
const results = Array.isArray(rawResults) ? rawResults : rawResults.results || [];
const mappedResults = results.map((r, i) => ({
  id: r.id || r.rule_id || `R${String(i + 1).padStart(3, "0")}`,
  label: r.rule || r.label || r.name || r.description || `Item ${i + 1}`,
  result: r.result || r.status || "unknown",
  confidence: r.confidence ?? r.score ?? null,
  page: r.page || r.page_ref || 1,
  // Detail fields — include whatever your workflow outputs
  detail: r.detail || Object.fromEntries(
    Object.entries(r).filter(([k]) => !["id","rule_id","rule","label","name","result","status","confidence","score","page","page_ref"].includes(k))
  ),
}));
// ============================================================

console.log(`PDF: ${pdfFileName} (${(pdfBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
console.log(`Results: ${mappedResults.length} items`);

// Generate HTML
const html = buildHTML(pdfBase64, pdfFileName, mappedResults);
fs.writeFileSync(outputPath, html, "utf-8");
console.log(`Output: ${outputPath} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)}MB)`);

function buildHTML(pdfB64, fileName, items) {
  const resultsJSON = JSON.stringify(items);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KC Review — ${fileName}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0a0a0a; --bg2: #141414; --bg3: #1e1e1e;
  --text: #e5e5e5; --dim: #888; --border: #2a2a2a;
  --green: #22c55e; --yellow: #eab308; --red: #ef4444;
  --blue: #3b82f6; --orange: #f97316;
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; }
#app { display: flex; height: 100vh; }
#pdf-panel { flex: 1; display: flex; flex-direction: column; border-right: 1px solid var(--border); min-width: 300px; }
#pdf-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
#pdf-toolbar button { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 13px; }
#pdf-toolbar button:hover { background: var(--border); }
#pdf-toolbar span { color: var(--dim); font-size: 13px; }
#pdf-toolbar input[type=number] { width: 50px; background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px; text-align: center; font-size: 13px; }
#pdf-container { flex: 1; overflow: auto; display: flex; flex-direction: column; align-items: center; padding: 16px; gap: 8px; }
.pdf-page-wrapper { position: relative; box-shadow: 0 2px 8px rgba(0,0,0,0.5); }
.pdf-page-wrapper canvas { display: block; }
.page-highlight { position: absolute; inset: 0; background: rgba(59,130,246,0.12); border: 2px solid var(--blue); pointer-events: none; opacity: 0; transition: opacity 0.3s; }
.page-highlight.active { opacity: 1; animation: pulse-border 1.5s ease-out; }
@keyframes pulse-border { 0% { border-color: var(--orange); box-shadow: 0 0 20px rgba(249,115,22,0.4); } 100% { border-color: var(--blue); box-shadow: none; } }
#drag-handle { width: 5px; background: var(--border); cursor: col-resize; flex-shrink: 0; transition: background 0.2s; }
#drag-handle:hover, #drag-handle.dragging { background: var(--blue); }
#results-panel { flex: 1; display: flex; flex-direction: column; min-width: 350px; }
#results-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; }
#results-toolbar .filter-btn { background: var(--bg3); color: var(--dim); border: 1px solid var(--border); border-radius: 12px; padding: 3px 10px; cursor: pointer; font-size: 12px; transition: all 0.2s; }
#results-toolbar .filter-btn.active { color: var(--text); border-color: var(--blue); background: rgba(59,130,246,0.15); }
#results-toolbar .summary { margin-left: auto; font-size: 12px; color: var(--dim); }
#results-list { flex: 1; overflow: auto; }
.result-item { border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; }
.result-item:hover { background: var(--bg3); }
.result-item.selected { background: rgba(59,130,246,0.1); border-left: 3px solid var(--blue); }
.result-row { display: flex; align-items: center; padding: 10px 12px; gap: 10px; }
.result-id { font-size: 11px; color: var(--dim); min-width: 40px; font-family: monospace; }
.result-label { flex: 1; font-size: 13px; }
.result-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
.badge-pass { background: rgba(34,197,94,0.15); color: var(--green); }
.badge-fail { background: rgba(239,68,68,0.15); color: var(--red); }
.badge-warning { background: rgba(234,179,8,0.15); color: var(--yellow); }
.badge-unknown { background: rgba(136,136,136,0.15); color: var(--dim); }
.result-confidence { font-size: 12px; color: var(--dim); min-width: 40px; text-align: right; }
.result-page { font-size: 11px; color: var(--dim); min-width: 30px; text-align: right; }
.result-detail { display: none; padding: 8px 12px 14px 62px; font-size: 12px; line-height: 1.6; color: var(--dim); border-top: 1px dashed var(--border); }
.result-item.expanded .result-detail { display: block; }
.detail-row { margin-bottom: 4px; }
.detail-key { color: var(--text); font-weight: 500; }
</style>
</head>
<body>
<div id="app">
  <div id="pdf-panel">
    <div id="pdf-toolbar">
      <button onclick="prevPage()">◀</button>
      <span>Page</span>
      <input type="number" id="page-input" value="1" min="1" onchange="goToPage(this.value)">
      <span id="page-count">/ ?</span>
      <button onclick="nextPage()">▶</button>
      <span style="margin-left:8px">|</span>
      <button onclick="zoomOut()">−</button>
      <span id="zoom-label">100%</span>
      <button onclick="zoomIn()">+</button>
      <button onclick="fitWidth()">Fit</button>
    </div>
    <div id="pdf-container"></div>
  </div>
  <div id="drag-handle"></div>
  <div id="results-panel">
    <div id="results-toolbar">
      <span class="summary" id="results-summary"></span>
    </div>
    <div id="results-list"></div>
  </div>
</div>
<script type="module">
const PDF_B64 = "${pdfB64}";
const RESULTS = ${resultsJSON};

// PDF setup
const pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs");
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";
const pdfData = Uint8Array.from(atob(PDF_B64), c => c.charCodeAt(0));
const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
const totalPages = pdf.numPages;
document.getElementById("page-count").textContent = "/ " + totalPages;
document.getElementById("page-input").max = totalPages;

let scale = 1.2, currentPage = 1;
const container = document.getElementById("pdf-container");
const pageCanvases = new Map();

async function renderAllPages() {
  container.innerHTML = ""; pageCanvases.clear();
  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale });
    const w = document.createElement("div");
    w.className = "pdf-page-wrapper"; w.id = "page-" + i;
    w.style.width = vp.width + "px"; w.style.height = vp.height + "px";
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    const hl = document.createElement("div"); hl.className = "page-highlight";
    w.appendChild(c); w.appendChild(hl); container.appendChild(w);
    pageCanvases.set(i, w);
  }
}
await renderAllPages();

function goToPage(n) { n = Math.max(1, Math.min(parseInt(n)||1, totalPages)); currentPage = n; document.getElementById("page-input").value = n; const el = document.getElementById("page-"+n); if(el) el.scrollIntoView({behavior:"smooth",block:"start"}); }
function prevPage() { goToPage(currentPage-1); }
function nextPage() { goToPage(currentPage+1); }
function zoomIn() { scale = Math.min(scale+0.2, 3); updateZoom(); }
function zoomOut() { scale = Math.max(scale-0.2, 0.4); updateZoom(); }
function fitWidth() { pdf.getPage(1).then(p => { scale = (document.getElementById("pdf-panel").clientWidth-40)/p.getViewport({scale:1}).width; updateZoom(); }); }
function updateZoom() { document.getElementById("zoom-label").textContent = Math.round(scale*100)+"%"; renderAllPages(); }
window.goToPage=goToPage; window.prevPage=prevPage; window.nextPage=nextPage;
window.zoomIn=zoomIn; window.zoomOut=zoomOut; window.fitWidth=fitWidth;

// Detect unique result statuses for filter buttons
const statuses = [...new Set(RESULTS.map(r => r.result))];
const toolbar = document.getElementById("results-toolbar");
const filterHTML = '<button class="filter-btn active" data-filter="all">All</button>' +
  statuses.map(s => '<button class="filter-btn" data-filter="'+s+'">'+s.charAt(0).toUpperCase()+s.slice(1)+'</button>').join("");
toolbar.insertAdjacentHTML("afterbegin", filterHTML);
let activeFilter = "all", selectedId = null;
toolbar.querySelectorAll(".filter-btn").forEach(b => b.addEventListener("click", () => {
  activeFilter = b.dataset.filter;
  toolbar.querySelectorAll(".filter-btn").forEach(x => x.classList.toggle("active", x.dataset.filter===activeFilter));
  selectedId = null; renderResults();
}));

function renderResults() {
  const list = document.getElementById("results-list");
  const filtered = activeFilter === "all" ? RESULTS : RESULTS.filter(r => r.result === activeFilter);
  const counts = statuses.map(s => RESULTS.filter(r=>r.result===s).length + " " + s).join(" · ");
  document.getElementById("results-summary").textContent = counts;

  list.innerHTML = filtered.map(r => {
    const bc = ["pass","fail","warning"].includes(r.result) ? "badge-"+r.result : "badge-unknown";
    const sel = r.id === selectedId ? " selected expanded" : "";
    const conf = r.confidence != null ? Math.round(r.confidence*100)+"%" : "";
    let detailHTML = "";
    if (r.detail && typeof r.detail === "object") {
      detailHTML = Object.entries(r.detail).map(([k,v]) =>
        '<div class="detail-row"><span class="detail-key">'+k+': </span>'+String(v)+'</div>'
      ).join("");
    }
    return '<div class="result-item'+sel+'" data-id="'+r.id+'" data-page="'+r.page+'">' +
      '<div class="result-row">' +
        '<span class="result-id">'+r.id+'</span>' +
        '<span class="result-label">'+r.label+'</span>' +
        '<span class="result-badge '+bc+'">'+r.result+'</span>' +
        (conf ? '<span class="result-confidence">'+conf+'</span>' : '') +
        '<span class="result-page">p.'+r.page+'</span>' +
      '</div>' +
      (detailHTML ? '<div class="result-detail">'+detailHTML+'</div>' : '') +
    '</div>';
  }).join("");

  list.querySelectorAll(".result-item").forEach(el => el.addEventListener("click", () => {
    const id = el.dataset.id, page = parseInt(el.dataset.page);
    if (selectedId === id) { selectedId = null; el.classList.remove("selected","expanded"); }
    else { list.querySelectorAll(".result-item").forEach(e=>e.classList.remove("selected","expanded")); selectedId = id; el.classList.add("selected","expanded"); }
    jumpToPage(page);
  }));
}

function jumpToPage(page) {
  currentPage = page; document.getElementById("page-input").value = page;
  const el = document.getElementById("page-"+page);
  if(el) { el.scrollIntoView({behavior:"smooth",block:"center"});
    const hl = el.querySelector(".page-highlight"); hl.classList.remove("active");
    void hl.offsetWidth; hl.classList.add("active"); setTimeout(()=>hl.classList.remove("active"),2000); }
}
renderResults();

// Drag handle
const handle = document.getElementById("drag-handle");
let dragging = false;
handle.addEventListener("mousedown", e => { dragging=true; handle.classList.add("dragging"); e.preventDefault(); });
document.addEventListener("mousemove", e => { if(!dragging) return; const r=e.clientX/document.getElementById("app").clientWidth; const c=Math.max(0.2,Math.min(0.8,r)); document.getElementById("pdf-panel").style.flex="0 0 "+(c*100)+"%"; document.getElementById("results-panel").style.flex="1"; });
document.addEventListener("mouseup", () => { dragging=false; handle.classList.remove("dragging"); });

container.addEventListener("scroll", () => {
  const cr = container.getBoundingClientRect(); let closest=1, cd=Infinity;
  pageCanvases.forEach((w,n) => { const d=Math.abs(w.getBoundingClientRect().top-cr.top); if(d<cd){cd=d;closest=n;} });
  if(closest!==currentPage){currentPage=closest;document.getElementById("page-input").value=closest;}
});
</script>
</body>
</html>`;
}
