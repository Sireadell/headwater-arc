// Writes each flagged audit result onto Arc mainnet as one transaction whose
// data is a short JSON memo: agent id, flagged reviewer wallets, the funding
// transaction behind each flag. Sent from the project wallet to itself, value 0.
// Run: MEMO_KEY_FILE=path/to/file-with-MINER_PRIVATE_KEY node --env-file=.env scripts/writeMemos.mjs [--send]
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
const audit = JSON.parse(fs.readFileSync('data/arc-audit.json', 'utf8'));
const donePath = 'data/arc-memos.json';
const done = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, 'utf8')) : {};

const memos = audit.results.filter((r) => r.flaggedReviewers > 0).map((r) => ({
  agent: r.agentId,
  status: r.status,
  linked: `${r.flaggedReviewers}/${r.reviewerCount}`,
  flags: r.reviewers.filter((x) => x.flags.length).map((x) => ({
    reviewer: x.reviewer,
    flag: x.flags.map((f) => f.type).join('+'),
    tx: x.flags.find((f) => f.tx)?.tx ?? null,
  })),
}));
const send = process.argv.includes('--send');
console.log('wallet', wallet.address, 'balance', ethers.formatEther(await provider.getBalance(wallet.address)), 'USDC', 'memos', memos.length);
for (const m of memos) {
  const data = ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify({ headwater: 1, ...m })));
  if (done[m.agent]) { console.log('skip', m.agent); continue; }
  const gas = await provider.estimateGas({ from: wallet.address, to: wallet.address, data });
  console.log(`agent ${m.agent}: ${(data.length - 2) / 2} bytes, gas ${gas}`);
  if (!send) continue;
  const tx = await wallet.sendTransaction({ to: wallet.address, value: 0, data });
  const rc = await tx.wait();
  done[m.agent] = { tx: tx.hash, block: rc.blockNumber };
  fs.writeFileSync(donePath, JSON.stringify(done, null, 1));
  console.log('sent', m.agent, tx.hash);
}
