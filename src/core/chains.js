// Chain registry for Arc, the one chain this build runs on. Kept as
// its own file (not folded into config.js) because publicChainClient.js
// and contractControlRisk.js/liveSolvencyRisk.js import
// publicRpcUrlsForChain() from here by name.

export const CHAINS = Object.freeze({
  arc: Object.freeze({
    key: 'arc',
    chainId: 5042,
    name: 'Arc',
    publicRpcUrl: 'https://rpc.mainnet.arc.io',
  }),
});

export const SUPPORTED_CHAIN_KEYS = Object.freeze(Object.keys(CHAINS));

export function normalizeChain(value) {
  const chain = String(value ?? 'arc').trim().toLowerCase();
  return Object.hasOwn(CHAINS, chain) ? chain : null;
}

export function getChainConfig(value) {
  const chain = normalizeChain(value);
  return chain ? CHAINS[chain] : null;
}

export function publicRpcUrlsForChain(chain, explicitUrl) {
  if (explicitUrl) return [explicitUrl];
  const selected = getChainConfig(chain);
  if (!selected) return [];
  return [selected.publicRpcUrl];
}
