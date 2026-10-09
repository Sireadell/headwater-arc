// Newest ratings on the home page. The snapshot supplies the latest ones; the
// page then asks Arc's public node for anything newer, so the feed is live
// without a server of ours.
(() => {
  const RPC = "https://rpc.mainnet.arc.io";
  const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
  // keccak256("NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)")
  const NEW_FEEDBACK = "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc";
  const WINDOW = 9999;
  const MAX_WINDOWS = 40;
  const statusEl = document.getElementById("live-status");
  const feedEl = document.getElementById("live-feed");
  let rows = [];
  let verdictOf = new Map();
  let scanned = 0;

  const rpc = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const b = await r.json();
    if (b.error) throw new Error(b.error.message);
    return b.result;
  };
  const ago = (t) => {
    const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
    if (s < 90) return "just now";
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  };
  const draw = () => {
    feedEl.innerHTML = rows.slice(0, 10).map((r) => {
      const v = verdictOf.get(String(r.agentId));
      const label = v ? badge(v.verdict, v.tone) : `<span class="badge badge-mut mono">NEW SINCE SNAPSHOT</span>`;
      return `<div class="live-row"><a class="live-agent mono" href="lookup.html?agent=${r.agentId}">agent ${r.agentId}</a><span class="live-who mono">${short(r.reviewer)}</span><span class="live-when">${ago(r.time)}</span>${label}</div>`;
    }).join("") || `<div class="live-row">No ratings yet.</div>`;
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
      statusEl.textContent = `live, block ${tip.toLocaleString("en-US")}`;
      draw();
    } catch (e) {
      statusEl.textContent = "snapshot only (Arc node busy)";
    }
  }

  (async () => {
    const [recent, idx] = await Promise.all([getJson("api/recent.json"), getJson("api/index.json")]);
    verdictOf = new Map(idx.agents.map((a) => [a.agentId, a]));
    rows = recent.recent;
    scanned = recent.snapshotToBlock;
    draw();
    await tick();
    setInterval(tick, 30000);
    setInterval(draw, 60000);
  })().catch((e) => { statusEl.textContent = "unavailable"; feedEl.innerHTML = `<div class="live-row error-state">${esc(e.message)}</div>`; });
})();
