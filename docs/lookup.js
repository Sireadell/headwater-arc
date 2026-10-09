chrome("lookup.html");
const input = document.getElementById("agentId");
const results = document.getElementById("results");
let indexCache = null;

function row(label, value) {
  return `<div class="info-row"><div class="info-item-label mono">${label}</div><div class="info-item-value mono">${value}</div></div>`;
}

function proofList(a) {
  const p = a.proof || {};
  const items = [];
  for (const d of p.ownerPaidRater || []) items.push(`The owner paid reviewer ${addrLink(d.rater)}${d.dust ? " (a small top-up)" : ""}: ${txLink(d.tx)}`);
  for (const d of p.ownerPaidViaWallet || []) items.push(`The owner paid ${addrLink(d.via)}: ${txLink(d.ownerToViaTx)}, and that wallet paid reviewer ${addrLink(d.rater)}: ${txLink(d.viaToRaterTx)}`);
  for (const d of p.raterPaidOwner || []) items.push(`Reviewer ${addrLink(d.rater)} paid the owner${d.afterRating ? " after rating" : " before rating"}: ${txLink(d.tx)}`);
  if (!items.length) return "";
  return `<div class="signals-title disp" style="margin-top:20px">Payments behind this verdict</div><div class="signals-list">${items.map((i) => `<div class="signal-row"><div class="signal-desc">${i}</div></div>`).join("")}</div>`;
}

function signalList(a) {
  if (!a.signals || !a.signals.length) return "";
  return `<div class="signals-title disp" style="margin-top:20px">Signal breakdown</div><div class="signals-list">${a.signals.map((s) => `<div class="signal-row"><div class="signal-title">${esc(s.title)} <span class="badge ${s.triggered ? "badge-amber" : "badge-mut"} mono" style="margin-left:8px">${s.triggered ? "TRIGGERED" : "CLEAR"}</span></div><div class="signal-desc">${esc(s.desc)}</div></div>`).join("")}</div><p class="footnote">Signals are context. Each says what it saw and never changes the verdict by itself.</p>`;
}

async function check(id) {
  results.innerHTML = `<div class="loading-state">Loading agent ${esc(id)}&hellip;</div>`;
  indexCache ??= await getJson("api/index.json");
  const total = indexCache.counts.agentsRegistered;
  if (!/^\d+$/.test(id) || Number(id) >= total) {
    results.innerHTML = `<div class="empty-state">Arc has agents 0 to ${total - 1}. Type a number in that range.</div>`;
    return;
  }
  let a;
  try { a = await getJson(`api/agents/${id}.json`); } catch (_) { a = null; }
  if (!a) {
    results.innerHTML = `<div class="lookup-body"><div style="flex:1"><div class="prov-card prov-mut"><div class="prov-head">${badge("NO EVIDENCE")}<span class="prov-title">Agent ${esc(id)}</span></div>
      <p class="prov-summary">This agent has no reviews in the published snapshot. That is the normal case on Arc: only ${indexCache.counts.agentsEverRated} of ${total.toLocaleString("en-US")} registered agents have any feedback. If it was rated after ${new Date(indexCache.generatedAt).toISOString().slice(0, 10)}, the next rebuild will show it.</p></div></div></div>`;
    return;
  }
  const e = a.evidence;
  const rings = (e.rings || []).map((r) => `<li>${r.kind}: wallet ${addrLink(r.source)} sits behind ${r.agents.length} agents (${r.agents.join(", ")}).</li>`).join("");
  results.innerHTML = `
  <div class="lookup-body">
    <div class="agent-panel">
      <div class="info-card">
        <div class="info-card-title mono">AGENT ${esc(a.agentId)}</div>
        ${row("OWNER", addrLink(a.owner))}
        ${row("REVIEWS", `${e.feedbackCount} from ${e.distinctRaters} wallet${e.distinctRaters === 1 ? "" : "s"}`)}
        ${row("REGISTRY AVERAGE", e.registryAverage)}
        ${row("PAID BY OWNER", `${e.ownerFundedDirect} direct, ${e.ownerFundedViaIntermediary} through another wallet`)}
        ${row("ROUND TRIP", e.roundTripped)}
        ${row("CONTRACT REVIEWERS", `${e.contractRaters} of ${e.ratersCheckedForCode} checked`)}
        ${a.proof && a.proof.record ? row("RECORD ON ARC", txLink(a.proof.record)) : ""}
      </div>
    </div>
    <div style="flex:1;min-width:0">
      <div class="prov-card prov-${a.tone}">
        <div class="prov-head">${badge(a.verdict, a.tone)}<span class="prov-title">What this agent&rsquo;s reputation is made of</span></div>
        <p class="prov-summary">${esc(a.summary)}</p>
        ${a.findings.length ? `<ul class="prov-findings">${a.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
        ${rings ? `<ul class="prov-findings">${rings}</ul>` : ""}
        <p class="prov-basis">Basis: ${e.ratersTraced} reviewer${e.ratersTraced === 1 ? "" : "s"} traced over ${a.limits.fundingHops} hops of USDC payments, blocks ${a.limits.window.fromBlock.toLocaleString("en-US")} to ${a.limits.window.toBlock.toLocaleString("en-US")}. ${e.ratersWithKnownFunder} of ${e.ratersTraced} have a funding record in that window. ${esc(a.limits.note)}</p>
      </div>
      ${proofList(a)}
      ${signalList(a)}
    </div>
  </div>`;
}

const go = () => { const id = input.value.trim(); history.replaceState(null, "", `?agent=${encodeURIComponent(id)}`); check(id); };
document.getElementById("checkBtn").onclick = go;
input.onkeydown = (ev) => { if (ev.key === "Enter") go(); };
const fromUrl = new URLSearchParams(location.search).get("agent");
if (fromUrl) input.value = fromUrl;
check(input.value.trim());
