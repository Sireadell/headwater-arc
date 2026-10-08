// Transport entrypoint for the funding-graph signals (fundingRelationship,
// circularFunding, clustering, fanOut, convergentRelayFunding,
// outboundRelationships). They import `callAnkr` from here by name, so
// their own detection logic never had to move. Every call goes to
// arcClient.js's callArc, translating the Ankr method name to the Arc
// equivalent.

import { callArc } from './arcClient.js';

const ANKR_TO_ARC_METHOD = {
  ankr_getTokenTransfers: 'arc_getTokenTransfers',
  ankr_getTransactionsByAddress: 'arc_getTransactionsByAddress',
};

export async function callAnkr(method, params, opts = {}) {
  const arcMethod = ANKR_TO_ARC_METHOD[method];
  if (!arcMethod) {
    throw new Error(`No Arc equivalent wired for Ankr method: ${method}`);
  }
  return callArc(arcMethod, params, opts);
}
