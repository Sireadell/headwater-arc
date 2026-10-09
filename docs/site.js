// Shared bits for every page: the header, verdict colours, small helpers.
const EXPLORER = "https://explorer.arc.io";
const REPO = "https://github.com/Sireadell/headwater-arc";
const BADGE = { red: "badge-red", amber: "badge-amber", mut: "badge-mut", green: "badge-green" };
const TONE_BY_VERDICT = {
  "NO EVIDENCE": "mut", "THIN": "amber", "SELF REVIEWED": "red", "APP GENERATED": "mut",
  "OWNER FUNDED": "red", "ROUND TRIP": "red", RING: "amber", "NO LINK FOUND": "mut",
};
const short = (a) => (a ? a.slice(0, 8) + "…" + a.slice(-6) : "");
const addrLink = (a) => `<a class="mono" href="${EXPLORER}/address/${a}">${short(a)}</a>`;
const txLink = (h) => (h ? `<a class="mono" href="${EXPLORER}/tx/${h}">${h.slice(0, 10)}…${h.slice(-6)}</a>` : "");
const badge = (verdict, tone) => `<span class="badge ${BADGE[tone || TONE_BY_VERDICT[verdict] || "mut"]} mono">${verdict}</span>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function chrome(active) {
  const links = [["index.html", "Home"], ["lookup.html", "Agent Lookup"], ["scoreboard.html", "Scoreboard"], ["methodology.html", "Methodology"]];
  document.getElementById("chrome").innerHTML = `
  <header class="topbar">
    <a class="brand" href="index.html"><span class="mark"></span><span class="disp brand-name">Headwater</span><span class="mono" style="font-size:12px;color:var(--text-faint);margin-left:4px">on Arc</span></a>
    <nav class="nav">${links.map(([h, l]) => `<a class="navlink${h === active ? " active" : ""}" href="${h}">${l}</a>`).join("")}</nav>
    <a class="sourcelink" href="${REPO}">View source</a>
  </header>`;
}
async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
