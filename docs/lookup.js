// Agent lookup. Reads api/index.json for the count and api/agents/<id>.json for one agent.
// A missing agent file means NO EVIDENCE, not an error.
chrome("lookup.html");
const input = document.getElementById("agentId");
const results = document.getElementById("results");
const helpEl = document.getElementById("helpLine");
const SIG_NAMES = {
  owner_funded_other_agents: ["Owner also paid reviewers of other agents", "HIGH"],
  circular_funding: ["Money sent back to the owner", "HIGH"],
  cross_agent_review_overlap: ["Same reviewers rated other agents", "MEDIUM"],
  funder_fan_out: ["One funder paid many wallets", "MEDIUM"],
  shared_funding_source: ["Reviewers funded from one wallet", "MEDIUM"],
  wallets_created_together: ["Reviewers funded at the same time", "MEDIUM"],
  automated_review_timing: ["Reviews at even intervals", "LOW"],
};
const LEVEL_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// The one sentence above the result. It is built from the agent's own counts.
function answerFor(a) {
  const e = a.evidence;
  const n = e.distinctRaters;
  const paid = e.ownerFundedDirect + e.ownerFundedViaIntermediary;
  switch (a.verdict) {
    case "THIN":
      return e.feedbackCount === 1 ? "The only review came from one reviewer." : `All ${e.feedbackCount} reviews came from one reviewer.`;
    case "OWNER FUNDED":
      if (paid === n) {
        if (n === 1) return "The only reviewer was paid by the owner.";
        if (n === 2) return "Both reviewers were paid by the owner.";
        return `All ${n} reviewers were paid by the owner.`;
      }
      return `${paid} of ${n} reviewers were paid by the owner.`;
    case "ROUND TRIP":
      return `The owner paid ${paid} of ${n} reviewers, and ${e.roundTripped} of them sent money back.`;
    case "SELF REVIEWED":
      return e.selfRated ? "The owner's own wallet is among the reviewers." : "The owner sent a review through another wallet.";
    case "RING":
      return "The reviewers trace back to one money source that also sits behind other agents.";
    case "NO LINK FOUND":
      return `We found no payment link within two steps for ${n} reviewers.`;
    case "APP GENERATED":
      return "Most reviewers are app programs recording outcomes, not people.";
    default:
      return a.summary;
  }
}

// Boxes and arrows, drawn from the payment proof. Each arrow links its transaction.
function moneyPath(a) {
  const p = a.proof || {};
  const owner = a.owner;
  const node = (label, addr) => `<div class="flow-node"><small>${label}</small><div class="flow-addr">${addrLink(addr, who(addr))}</div></div>`;
  const arrow = (label, tx) => `<div class="flow-arrow"><span class="flow-label">${esc(label)}</span><span class="flow-tx">${tx ? txLink(tx) : ""}</span></div>`;
  // One block per reviewer: how the owner paid them, then any money sent back.
  const byRater = new Map();
  const group = (r) => {
    if (!byRater.has(r)) byRater.set(r, { direct: [], via: [], back: [] });
    return byRater.get(r);
  };
  for (const d of p.ownerPaidRater || []) group(d.rater).direct.push(d);
  for (const d of p.ownerPaidViaWallet || []) group(d.rater).via.push(d);
  for (const d of p.raterPaidOwner || []) group(d.rater).back.push(d);
  if (!byRater.size) {
    return `<p class="muted">No payment link found between the owner and these reviewers within ${a.limits.fundingHops} steps.</p>`;
  }
  const blocks = [...byRater.entries()].map(([rater, g]) => {
    const rows = g.direct.map((d) => `<div class="flow">${node("Agent owner", owner)}${arrow(d.dust ? "paid a small top-up" : "paid directly", d.tx)}${node("Reviewer", rater)}</div>`);
    if (g.via.length) {
      rows.push(`<div class="flow">${node("Agent owner", owner)}${arrow(`paid through ${g.via.length} ${plural(g.via.length, "wallet", "wallets")}`, null)}${node("Reviewer", rater)}</div>`);
      const chips = g.via.map((d) => `<span class="mid-chip mono">${addrLink(d.via, who(d.via))} <span class="mid-links">${txLink(d.ownerToViaTx, "payment in")} · ${txLink(d.viaToRaterTx, "payment out")}</span></span>`).join("");
      rows.push(`<div class="mid-list"><span class="mid-label">Through</span>${chips}</div>`);
    }
    for (const d of g.back) {
      rows.push(`<div class="flow">${node("Reviewer", rater)}${arrow(d.afterRating ? "sent back, after rating" : "sent, before rating", d.tx)}${node("Agent owner", owner)}</div>`);
    }
    return `<div class="rev-block">${rows.join("")}</div>`;
  });
  const shown = blocks.slice(0, 4).join("");
  const rest = blocks.slice(4);
  if (!rest.length) return shown;
  return `${shown}<div class="more-blocks" hidden>${rest.join("")}</div><button type="button" class="more-btn" data-more>Show ${rest.length} more ${plural(rest.length, "reviewer", "reviewers")}</button>`;
}

document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-more]");
  if (!b) return;
  b.previousElementSibling.hidden = false;
  b.remove();
});

function signalsFor(a) {
  const list = (a.signals || []).map((s) => {
    const known = SIG_NAMES[s.key] || [s.title, "LOW"];
    return { name: known[0], level: s.triggered ? known[1] : "NOT FOUND", desc: s.desc, triggered: s.triggered };
  });
  list.sort((x, y) => (x.triggered === y.triggered ? (LEVEL_ORDER[x.level] ?? 3) - (LEVEL_ORDER[y.level] ?? 3) : x.triggered ? -1 : 1));
  return list.map((s) => `
    <div class="sig">
      <span class="lvl lvl-${s.triggered ? s.level.toLowerCase() : "none"}">${s.level}</span>
      <div><div class="sig-name">${esc(s.name)}</div><div class="sig-desc">${esc(s.desc)}</div></div>
    </div>`).join("");
}

function infoCard(a) {
  const e = a.evidence;
  const paid = e.ownerFundedDirect + e.ownerFundedViaIntermediary;
  const row = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  return `
    <div class="info-card">
      <div class="info-title mono">AGENT ${esc(a.agentId)}</div>
      ${row("Owner", addrLink(a.owner))}
      ${row("Reviewers", e.distinctRaters)}
      ${row("Reviews", e.feedbackCount)}
      ${row("Average", averageText(e.distinctRaters))}
      ${row("Paid by the owner", `${paid} of ${e.distinctRaters} reviewers`)}
      ${row("Money back to the owner", `${e.roundTripped} ${plural(e.roundTripped, "reviewer", "reviewers")}`)}
      ${row("Game or app programs among reviewers", `${e.contractRaters} of ${e.ratersCheckedForCode} checked`)}
      ${a.proof && a.proof.record ? row("Saved on Arc", txLink(a.proof.record, "view the record")) : ""}
    </div>`;
}

function renderAgent(a) {
  const e = a.evidence;
  const tone = toneOf(a.verdict, e.distinctRaters, a.tone);
  const disclosure = JSON.stringify(a).toLowerCase().includes(HEADWATER_WALLET)
    ? `<div class="disclosure"><b>Disclosure.</b> This review came from Headwater's own record wallet. Count it as zero.${e.paidOwnerBeforeAgentExisted ? " The same wallet also sent money to this agent's owner before the agent was registered." : ""}</div>`
    : "";
  const from = a.limits.window.fromBlock.toLocaleString("en-US");
  const to = a.limits.window.toBlock.toLocaleString("en-US");
  return `
    ${disclosure}
    <h2 class="answer">${esc(answerFor(a))}</h2>
    <div class="result">
      <div class="result-verdict card-tone tone-${tone}">
        <div class="verdict-line">${verdictTag(a.verdict, tone)}</div>
        ${strengthHtml(e.distinctRaters)}
        <p class="verdict-text">${esc(a.summary)}</p>
      </div>
      <div class="result-info">${infoCard(a)}</div>
      <div class="card result-money">
        <h3 class="card-title">Where the money went</h3>
        <p class="card-sub">A wallet is an Arc address that holds money. Each arrow is one payment. Its link opens the payment on the Arc explorer.</p>
        ${moneyPath(a)}
      </div>
      <div class="card result-signals">
        <h3 class="card-title">What else we checked</h3>
        <div class="sig-list">${signalsFor(a)}</div>
        <p class="note">Signals are context. None of them changes the verdict by itself.</p>
      </div>
      <p class="note result-basis">Checked ${e.ratersTraced} reviewers and the payments within ${a.limits.fundingHops} steps, using Arc history from block ${from} to ${to}. We found where the money came from for ${e.ratersWithKnownFunder} of ${e.ratersTraced}. ${esc(a.limits.note)}</p>
    </div>`;
}

function renderNoEvidence(id, idx) {
  const none = idx.counts.agentsRegistered - idx.counts.agentsEverRated;
  return `
    <h2 class="answer">Agent ${esc(id)} has no reviews yet.</h2>
    <div class="result">
      <div class="result-verdict card-tone tone-grey">
        <div class="verdict-line">${verdictTag("NO EVIDENCE", "grey")}</div>
        <p class="verdict-text">Most agents on Arc have none (${fmt(none)} of ${fmt(idx.counts.agentsRegistered)}). Try 346, 196 or 1 to see a result.</p>
      </div>
    </div>`;
}

async function check(raw) {
  const id = String(raw).trim();
  results.innerHTML = `<div class="loading" role="status">Loading agent ${esc(id)}…</div>`;
  let idx;
  try {
    idx = await loadIndex();
  } catch (_) {
    results.innerHTML = `<div class="notice">The agent list could not load. Try again in a moment.</div>`;
    return;
  }
  const total = idx.counts.agentsRegistered;
  helpEl.textContent = `Type a number from 0 to ${total - 1}. Arc gives each agent one.`;
  if (!/^\d+$/.test(id)) {
    results.innerHTML = `<div class="notice">Type an agent number from 0 to ${total - 1}.</div>`;
    return;
  }
  if (Number(id) >= total) {
    results.innerHTML = `<div class="notice">There is no agent ${esc(id)} on Arc. Agents run from 0 to ${total - 1}.</div>`;
    return;
  }
  let a = null;
  try {
    a = await getJson(`api/agents/${Number(id)}.json`);
  } catch (err) {
    if (err.status !== 404) {
      results.innerHTML = `<div class="notice">This agent could not load. Try again in a moment.</div>`;
      return;
    }
  }
  results.innerHTML = a ? renderAgent(a) : renderNoEvidence(id, idx);
}

function go(id) {
  input.value = id;
  history.replaceState(null, "", `?agent=${encodeURIComponent(id)}`);
  check(id);
}
document.getElementById("checkBtn").onclick = () => go(input.value.trim());
input.onkeydown = (ev) => { if (ev.key === "Enter") go(input.value.trim()); };
document.querySelectorAll("[data-example]").forEach((b) => { b.onclick = () => go(b.dataset.example); });

const fromUrl = new URLSearchParams(location.search).get("agent");
go(fromUrl !== null ? fromUrl : "346");
