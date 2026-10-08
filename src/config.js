// Central config. Arc-only build. Copied signal files still read
// config.chain and a handful of other fields by the same names.

const PUBLIC_ARC_RPC = 'https://rpc.mainnet.arc.io';

// Dwellir's Arc endpoint is the fast path (100 requests a second on the
// plan we hold) but caps eth_getLogs at 500 blocks. Arc's public endpoint
// allows 10,000 blocks per call but rate limits hard, so it is the backup.
const dwellirArcUrl = process.env.DWELLIR_ARC_URL || undefined;

export const config = {
  chain: process.env.CHAIN || 'arc',

  arcRpcUrls: (process.env.ARC_RPC_URLS || [dwellirArcUrl, PUBLIC_ARC_RPC].filter(Boolean).join(','))
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  arcReadRpcUrl: dwellirArcUrl ?? PUBLIC_ARC_RPC,
  arcLogBlockWindow: Number(process.env.ARC_LOG_BLOCK_WINDOW) || (dwellirArcUrl ? 500 : 10_000),
  arcLogConcurrency: Number(process.env.ARC_LOG_CONCURRENCY) || (dwellirArcUrl ? 40 : 2),
  // First block worth scanning for USDC funding. Checked live 2026-10-08:
  // the system emitter has no payments in the first 5,000,000 blocks, a
  // handful around 10,000,000 and 15,000,000, and thousands from about
  // 20,000,000. A first try starting at 21,000,000 left 4 of 30 reviewers
  // with no funder found, so the default starts at 10,000,000.
  arcScanStartBlock: Number(process.env.ARC_SCAN_START_BLOCK) || 10_000_000,
  arcTransferIndexPath: process.env.ARC_TRANSFER_INDEX || 'data/arc-transfer-index.json',

  knownExchangeAddresses: (process.env.KNOWN_EXCHANGE_ADDRESSES || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.startsWith('0x')),

  optionalSignalDeadlineMs: Number(process.env.OPTIONAL_SIGNAL_DEADLINE_MS) || 2_500,
};
