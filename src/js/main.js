/* ═══════════════════════════════════════════════
   DevWrap — SC-ECE Presents
   main.js
   ═══════════════════════════════════════════════ */

/* ════════════════════════════════
   Config
════════════════════════════════ */

const CONFIG = {
  grid: {
    cols: 28,
    rows: 10,
    colors: ["#00C896", "#00A87A", "#006B4F", "#B8F5E0", "#00E8A8"],
    shadeProbability: 0.4, // cells with shade > this value get a color
    maxDelay: 1.77,
  },
  phases: {
    devwrapReveal: 5200,  // ms — hide loader, show devwrap screen
    welcome:       6500,  // ms — show welcome message
  },
};

/* ════════════════════════════════
   DOM References
════════════════════════════════ */

const root      = document.getElementById("root");
const loader    = document.getElementById("loader");
const devwrap   = document.getElementById("devwrap");
const welcomeEl = document.getElementById("welcome-msg");
const pixelGrid = document.getElementById("pixel-grid");

/* ════════════════════════════════
   Pixel Grid Builder
════════════════════════════════ */

function buildPixelGrid() {
  const { cols, rows, colors, shadeProbability, maxDelay } = CONFIG.grid;
  const frag = document.createDocumentFragment();

  for (let i = 0; i < cols * rows; i++) {
    const cell  = document.createElement("div");
    cell.className = "pixel";

    const shaded = Math.random() > shadeProbability;
    const delay  = Math.random() * maxDelay;
    const color  = colors[Math.floor(Math.random() * colors.length)];

    cell.style.background     = shaded ? color : "transparent";
    cell.style.animation      = `pixelBlink ${1.5 + delay}s ease-in-out infinite`;
    cell.style.animationDelay = `${delay}s`;

    frag.appendChild(cell);
  }

  pixelGrid.appendChild(frag);
}

/* ════════════════════════════════
   Phase Handlers
════════════════════════════════ */

function showDevWrap() {
  root.style.background  = "#0A0A0A";
  loader.style.display   = "none";
  devwrap.style.display  = "flex";
}

function showWelcome() {
  welcomeEl.style.display = "block";
}

/* ════════════════════════════════
   Phase Timeline
════════════════════════════════
   Mirrors the original React component phases:
   black → sc-ece-reveal (400ms) → sc-ece-hold (2500ms)
   → transition (4200ms) → devwrap-reveal (5200ms)
   → welcome (6500ms) → complete (8500ms)
════════════════════════════════ */

function initTimeline() {
  setTimeout(showDevWrap, CONFIG.phases.devwrapReveal);
  setTimeout(showWelcome, CONFIG.phases.welcome);
}

/* ════════════════════════════════
   Init
════════════════════════════════ */

(function init() {
  buildPixelGrid();
  initTimeline();
})();
