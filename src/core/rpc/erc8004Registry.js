// Reads the real ERC-8004 Identity and Reputation registries on Arc
// mainnet. Confirmed live on
// Arc 2026-10-08: both addresses hold bytecode, and agent ids 0 to 2313
// are registered.
//
// Function signatures below are copied from the actual reference
// contracts, not guessed from the spec doc (the spec doc alone does not
// give exact signatures): fetched from
// github.com/erc-8004/erc-8004-contracts, contracts/
// IdentityRegistryUpgradeable.sol and ReputationRegistryUpgradeable.sol,
// 2026-09-16.
//
// Two different addresses matter per agent, and they are not the same
// thing:
//   - ownerOf(agentId): the ERC-721 owner, who controls the identity NFT.
//   - getAgentWallet(agentId): the agent's own operational wallet, stored
//     as metadata, cleared on transfer. This is the wallet that actually
//     pays for and receives things on the agent's behalf, so it is the
//     one Headwater's funding signals should run against, not the NFT
//     owner.
//
// The identity registry has no enumeration function (no totalSupply,
// no tokenByIndex, it is ERC721URIStorage not ERC721Enumerable). Agent
// IDs are sequential starting at 0 (register() does agentId = _lastId++),
// so listing agents means walking ownerOf(0), ownerOf(1), ... until a
// call reverts, which is what listAgents() below does.

import { ethers } from 'ethers';
import { config } from '../../config.js';

export const IDENTITY_REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const REPUTATION_REGISTRY_ADDRESS = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

const IDENTITY_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function register() returns (uint256 agentId)',
  'function register(string agentURI) returns (uint256 agentId)',
];

const REPUTATION_ABI = [
  'function getClients(uint256 agentId) view returns (address[])',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)',
];

let providerInstance;
function getProvider() {
  if (!providerInstance) {
    // ethers' FallbackProvider would treat every configured URL as a
    // consensus source and fail if they ever disagree; that's the wrong
    // model for "try the next public endpoint if this one is down". A
    // plain JsonRpcProvider against the first URL is enough for phase 2's
    // read-only volume; multi-endpoint failover can be added if a single
    // public endpoint proves unreliable in practice.
    // Registry reads are plain eth_call, which Alchemy serves well, so use it
    // when a key is set and fall back to the public endpoint otherwise.
    const url = config.arcReadRpcUrl;
    providerInstance = new ethers.JsonRpcProvider(url, 5042, { staticNetwork: true });
  }
  return providerInstance;
}

function identityContract() {
  return new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_ABI, getProvider());
}

function reputationContract() {
  return new ethers.Contract(REPUTATION_REGISTRY_ADDRESS, REPUTATION_ABI, getProvider());
}

/**
 * Walk agent IDs from startId upward until ownerOf() reverts (past the
 * last registered agent) or maxAgents is reached. No enumeration function
 * exists on the contract, this is the only way to list agents.
 *
 * @param {{ startId?: number, maxAgents?: number }} [opts]
 * @returns {Promise<{ agentId: number, owner: string }[]>}
 */
const LIST_BATCH_SIZE = 25;

export async function listAgents({ startId = 0, maxAgents = 200 } = {}) {
  const identity = identityContract();
  const agents = [];
  for (let base = startId; agents.length < maxAgents; base += LIST_BATCH_SIZE) {
    const batchIds = Array.from(
      { length: Math.min(LIST_BATCH_SIZE, maxAgents - agents.length) },
      (_, i) => base + i
    );
    // ownerOf calls for different agent IDs don't depend on each other,
    // so fire them in parallel and only walk the results in ID order
    // afterward. Cut demo.mjs's real-mainnet scan time from ~90s to well
    // under that, confirmed live 2026-09-16.
    const results = await Promise.all(batchIds.map(async (id) => {
      try {
        return { id, owner: await identity.ownerOf(id) };
      } catch (err) {
        if (isNonexistentTokenRevert(err)) return { id, owner: null };
        throw err;
      }
    }));
    for (const { id, owner } of results) {
      if (owner === null) return agents; // walked past the last agent
      agents.push({ agentId: id, owner });
    }
  }
  return agents;
}

// Selector of ERC721NonexistentToken(uint256). Dwellir's Arc endpoint
// returns the raw revert data without a decoded name, so the message
// alone reads "unknown custom error". Seen live 2026-10-08 at agent 2314.
const NONEXISTENT_TOKEN_SELECTOR = '0x7e273289';

function isNonexistentTokenRevert(err) {
  if (String(err?.data ?? '').toLowerCase().startsWith(NONEXISTENT_TOKEN_SELECTOR)) return true;
  const msg = String(err?.shortMessage ?? err?.message ?? '');
  return msg.includes('ERC721NonexistentToken') || msg.includes('missing revert data') || msg.includes('could not decode result data');
}

/**
 * @param {number} agentId
 * @returns {Promise<string>} the agent's own operational wallet, not the NFT owner
 */
export async function getAgentWallet(agentId) {
  return identityContract().getAgentWallet(agentId);
}

/**
 * @param {number} agentId
 * @returns {Promise<string[]>} every wallet that has ever given this agent feedback
 */
export async function getReviewers(agentId) {
  // ethers returns a Result (array-like, but read-only/frozen internals),
  // not a plain array. Passing it straight back into another contract
  // call as an address[] argument throws deep inside ethers' encoder
  // ("Cannot assign to read only property '0'"), confirmed live
  // 2026-09-16. Convert to a plain array here so every caller gets
  // something safe to pass around and re-use.
  const clients = await reputationContract().getClients(agentId);
  return Array.from(clients);
}

/**
 * @param {number} agentId
 * @param {string[]} clientAddresses reviewer wallets to read, required by the contract (no "all" default in getSummary)
 * @returns {Promise<{ count: bigint, summaryValue: bigint, summaryValueDecimals: number }>}
 */
export async function getReputationSummary(agentId, clientAddresses) {
  const [count, summaryValue, summaryValueDecimals] = await reputationContract()
    .getSummary(agentId, clientAddresses, '', '');
  return { count, summaryValue, summaryValueDecimals };
}

/**
 * @param {number} agentId
 * @param {string[]} [clientAddresses] omit to read every known reviewer
 * @returns {Promise<Array<{ client: string, feedbackIndex: bigint, value: bigint, valueDecimals: number, tag1: string, tag2: string, revoked: boolean }>>}
 */
export async function readAllFeedback(agentId, clientAddresses = []) {
  const result = await reputationContract()
    .readAllFeedback(agentId, clientAddresses, '', '', false);
  const [clients, feedbackIndexes, values, valueDecimals, tag1s, tag2s, revokedStatuses] = result;
  return clients.map((client, i) => ({
    client,
    feedbackIndex: feedbackIndexes[i],
    value: values[i],
    valueDecimals: valueDecimals[i],
    tag1: tag1s[i],
    tag2: tag2s[i],
    revoked: revokedStatuses[i],
  }));
}
