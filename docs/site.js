// Shared by every page: the header, data loading and small helpers.
// Every number shown on the site is read from api/*.json, never typed in.
const EXPLORER = "https://explorer.arc.io";
const REPO = "https://github.com/Sireadell/headwater-arc";
const HEADWATER_WALLET = "0xb3fb14fecac09efbd0c74fc07d50d7ed1eef2b53";
const NAV = [
  ["index.html", "Home"],
  ["lookup.html", "Agent lookup"],
  ["scoreboard.html", "Scoreboard"],
  ["methodology.html", "How we check it"],
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString("en-US");
const plural = (n, one, many) => (n === 1 ? one : many);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const who = (a) => (a === HEADWATER_WALLET ? "Headwater's own wallet" : short(a));
const addrLink = (a, label) => `<a class="mono" href="${EXPLORER}/address/${a}" target="_blank" rel="noopener">${esc(label || short(a))}</a>`;
const txLink = (h, label) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener">${esc(label || "view payment")}</a>`;

// One colour per result. Under 3 reviewers it is always amber, never red.
function toneOf(verdict, reviewers, apiTone) {
  if (verdict === "NO EVIDENCE") return "grey";
  if (reviewers < 3) return "amber";
  return apiTone === "red" ? "red" : apiTone === "amber" ? "amber" : "grey";
}
const TAG = { red: "tag-red", amber: "tag-amber", grey: "tag-grey" };
const verdictTag = (verdict, tone) => `<span class="tag ${TAG[tone] || "tag-grey"}">${esc(verdict)}</span>`;

// Strength meter with three bars. Amber and "Too few to judge" under 3 reviewers.
function strengthHtml(reviewers) {
  const filled = Math.min(reviewers, 3);
  const cls = reviewers < 3 ? "meter-amber" : "meter-green";
  const bars = [0, 1, 2].map((i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("");
  const line = reviewers < 3
    ? `<b class="amber-text">Too few to judge.</b> Based on ${reviewers} ${plural(reviewers, "reviewer", "reviewers")}.`
    : `Based on ${reviewers} reviewers.`;
  return `<div class="strength"><span class="meter ${cls}" aria-hidden="true">${bars}</span><span>${line}</span></div>`;
}

// No average is printed until its scale is confirmed. Under 3 reviewers we say why.
function averageText(distinctRaters) {
  return distinctRaters < 3 ? "Not enough reviews to average." : "Not shown. The score scale is not confirmed yet.";
}

function ago(t) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const cache = {};
function getJson(path) {
  if (!cache[path]) {
    cache[path] = fetch(path).then((r) => {
      if (!r.ok) {
        const err = new Error(`${path}: HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      return r.json();
    });
  }
  return cache[path];
}
const loadIndex = () => getJson("api/index.json");

function chrome(active) {
  const el = document.getElementById("chrome");
  if (!el) return;
  el.innerHTML = `
  <header class="topbar">
    <a class="brand" href="index.html"><span class="mark" aria-hidden="true"></span><span class="disp brand-name">Headwater</span><span class="brand-sub mono">on Arc</span></a>
    <nav class="nav" aria-label="Main">${NAV.map(([h, l]) => `<a class="navlink${h === active ? " active" : ""}" href="${h}">${l}</a>`).join("")}</nav>
    <a class="sourcelink" href="${REPO}" target="_blank" rel="noopener">View source</a>
  </header>`;
}
