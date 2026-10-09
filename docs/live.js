// Newest reviews on the home page, grouped by reviewer. The published list gives
// the latest ones; the page then asks Arc's public node for anything newer.
// If the node does not answer, the published list is shown and the status says so.
(() => {
  const RPC = "https://rpc.mainnet.arc.io";
  const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
  // keccak256("NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)")
  const NEW_FEEDBACK = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc";
  const WINDOW = 9999;
  const MAX_WINDOWS = 40;
  const statusEl = document.getElementById("live-status");
  const feedEl = document.getElementById("live-feed");
  const sentenceEl = document.getElementById("feed-sentence");
  const noteEl = document.getElementById("live-note");
  let rows = [];
  let verdictOf = new Map();
  let scanned = 0;
  let liveOk = false;

  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const b = await r.json();
    if (b.error) throw new Error(b.error.message);
    return b.result;
  };

  // Group the newest rows by reviewer, most rows first.
  const groups = () => {
    const map = new Map();
    for (const r of rows.slice(0, 10)) {
      if (!map.has(r.reviewer)) map.set(r.reviewer, []);
      map.get(r.reviewer).push(r);
    }
    return [...map.entries()].map(([reviewer, list]) => ({ reviewer, list })).sort((a, b) => b.list.length - a.list.length);
  };

  const draw = () => {
    const shown = rows.slice(0, 10);
    if (!shown.length) {
      sentenceEl.textContent = "";
      feedEl.innerHTML = `<div class="feed-row muted">No reviews yet.</div>`;
      return;
    }
    const top = groups()[0];
    const agents = new Set(top.list.map((r) => r.agentId)).size;
    sentenceEl.textContent = top.list.length > 1
      ? `One reviewer left ${top.list.length} of the ${shown.length} newest reviews, on ${agents} different agents.`
      : `Each of the ${shown.length} newest reviews came from a different reviewer.`;
    feedEl.innerHTML = groups().map((g) => {
      const ids = g.list.map((r) => Number(r.agentId));
      const lo = Math.min(...ids);
      const hi = Math.max(...ids);
      const chips = g.list.map((r) => {
        const v = verdictOf.get(String(r.agentId));
        const tag = v ? verdictTag(v.verdict, toneOf(v.verdict, v.distinctRaters, v.tone)) : `<span class="tag tag-grey">Not checked yet</span>`;
        return `<a class="feed-chip" href="lookup.html?agent=${r.agentId}">${r.agentId} ${tag}</a>`;
      }).join("");
      const newest = Math.max(...g.list.map((r) => r.time));
      const range = lo === hi ? `agent ${lo}` : `agents ${lo} to ${hi}`;
      return `<div class="feed-row">
        <div class="feed-who"><span class="mono">${addrLink(g.reviewer, short(g.reviewer))}</span><span class="muted small">${g.list.length} ${g.list.length === 1 ? "review" : "reviews"}, ${range} · ${ago(newest)}</span></div>
        <div class="feed-tags">${chips}</div>
      </div>`;
    }).join("");
  };

  async function scan(from, to) {
    const found = [];
    let windows = 0;
    for (let start = from; start <= to && windows < MAX_WINDOWS; start += WINDOW + 1, windows++) {
      const end = Math.min(start + WINDOW, to);
      const logs = await rpc("eth_getLogs", [{ fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16), address: REPUTATION, topics: [NEW_FEEDBACK] }]);
      for (const l of logs) {
        const blk = await rpc("eth_getBlockByNumber", [l.blockNumber, false]);
        found.push({ agentId: parseInt(l.topics[1], 16), reviewer: "0x" + l.topics[2].slice(26), block: parseInt(l.blockNumber, 16), time: parseInt(blk.timestamp, 16), tx: l.transactionHash });
      }
    }
    return found;
  }

  async function tick() {
    try {
      const tip = parseInt(await rpc("eth_blockNumber", []), 16);
      if (tip > scanned) {
        const fresh = await scan(Math.max(scanned + 1, tip - MAX_WINDOWS * WINDOW), tip);
        scanned = tip;
        if (fresh.length) {
          const seen = new Set(rows.map((r) => r.tx + r.agentId));
          rows = [...fresh.filter((f) => !seen.has(f.tx + f.agentId)), ...rows].sort((a, b) => b.block - a.block);
        }
      }
      liveOk = true;
      statusEl.textContent = "Live";
      draw();
    } catch (e) {
      statusEl.textContent = liveOk ? "Live, paused" : "Last check";
      noteEl.textContent = "Newest reviews from our last check. The live read of Arc did not answer.";
    }
  }

  (async () => {
    const [recent, idx] = await Promise.all([getJson("api/recent.json"), getJson("api/index.json")]);
    verdictOf = new Map(idx.agents.map((a) => [String(a.agentId), a]));
    rows = recent.recent;
    scanned = recent.snapshotToBlock;
    draw();
    await tick();
    setInterval(tick, 30000);
    setInterval(draw, 60000);
  })().catch((e) => {
    statusEl.textContent = "Unavailable";
    feedEl.innerHTML = `<div class="feed-row notice">${esc(e.message)}</div>`;
  });
})();
