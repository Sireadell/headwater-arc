// Writes each finding onto Arc mainnet as one transaction whose data is a
// short readable JSON note: the agent, its verdict, and the payments behind
// it. Sent from the project wallet to itself, value 0.
//
// Which agents get a record: every agent whose verdict is a finding
// (OWNER FUNDED, ROUND TRIP, SELF REVIEWED, RING), plus any agent that already
// has an older record, so the newest record for an agent is never out of date.
// If an agent's note has changed since its last record, a new record is sent
// and the old one is kept in history. Unchanged notes are skipped.
//
// Run: MEMO_KEY_FILE=path/to/file-with-MINER_PRIVATE_KEY node --env-file=.env scripts/writeMemos.mjs [--send]
// Without --send it only prints what it would send.
import fs from 'node:fs';
import { ethers } from 'ethers';
import { config } from '../src/config.js';

const KEY_FILE = process.env.MEMO_KEY_FILE;
if (!KEY_FILE) {
  console.error('MEMO_KEY_FILE is not set, so nothing was sent. Point it at a file holding MINER_PRIVATE_KEY.');
  process.exit(1);
}
const key = fs.readFileSync(KEY_FILE, 'utf8').match(/^MINER_PRIVATE_KEY=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
const provider = new ethers.JsonRpcProvider(config.arcReadRpcUrl, 5042, { staticNetwork: true });
const wallet = new ethers.Wallet(key, provider);
const donePath = 'data/arc-memos.json';
const done = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, 'utf8')) : {};
const index = JSON.parse(fs.readFileSync('docs/api/index.json', 'utf8'));

const FINDINGS = new Set(['OWNER FUNDED', 'ROUND TRIP', 'SELF REVIEWED', 'RING']);
const targets = index.agents.filter((a) => FINDINGS.has(a.verdict) || done[a.agentId]);

function noteFor(id) {
  const a = JSON.parse(fs.readFileSync(`docs/api/agents/${id}.json`, 'utf8'));
  const p = a.proof;
  const note = {
    headwater: 2,
    agent: Number(id),
    verdict: a.verdict,
    owner: a.owner,
    reviewers: a.evidence.distinctRaters,
    ownerPaid: p.ownerPaidRater.map((d) => ({ reviewer: d.rater, tx: d.tx })),
    viaWallet: p.ownerPaidViaWallet.map((d) => ({ reviewer: d.rater, via: d.via, tx1: d.ownerToViaTx, tx2: d.viaToRaterTx })),
    reviewerPaidOwner: p.raterPaidOwner.map((d) => ({ reviewer: d.rater, tx: d.tx, afterRating: d.afterRating })),
    rings: a.evidence.rings.map((r) => ({ source: r.source, agents: r.agents })),
  };
  for (const k of Object.keys(note)) if (Array.isArray(note[k]) && note[k].length === 0) delete note[k];
  return JSON.stringify(note);
}

const send = process.argv.includes('--send');
console.log('wallet', wallet.address, 'balance', ethers.formatEther(await provider.getBalance(wallet.address)), 'USDC', 'agents to consider', targets.length);
let toSend = 0;
for (const t of targets) {
  const id = t.agentId;
  const data = ethers.hexlify(ethers.toUtf8Bytes(noteFor(id)));
  if (done[id]) {
    const prev = await provider.getTransaction(done[id].tx);
    if (prev && prev.data.toLowerCase() === data.toLowerCase()) continue;
  }
  toSend++;
  const gas = await provider.estimateGas({ from: wallet.address, to: wallet.address, data });
  console.log(`agent ${id} (${t.verdict}): ${(data.length - 2) / 2} bytes, gas ${gas}${done[id] ? ', replaces an older record' : ''}`);
  if (!send) continue;
  const tx = await wallet.sendTransaction({ to: wallet.address, value: 0, data });
  const rc = await tx.wait();
  const history = [...(done[id]?.history ?? []), ...(done[id] ? [{ tx: done[id].tx, block: done[id].block }] : [])];
  done[id] = { tx: tx.hash, block: rc.blockNumber, verdict: t.verdict, history };
  fs.writeFileSync(donePath, JSON.stringify(done, null, 1));
  console.log('sent', id, tx.hash);
}
console.log(toSend === 0 ? 'Nothing to send: every record on Arc is up to date.' : `${toSend} record${toSend === 1 ? '' : 's'} ${send ? 'sent' : 'would be sent'}.`);
