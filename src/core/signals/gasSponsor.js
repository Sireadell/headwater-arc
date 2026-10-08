// GAS-SPONSOR SIGNAL (added 2026-08-21). Every other signal in this codebase
// asks "who sent this wallet money." This asks a different question: "who
// actually paid the gas for this wallet's own outbound activity." On a plain
// EOA wallet those are the same account by construction — you sign your own
// transaction, you pay your own gas. But an operator running a smart-contract
// wallet (or any relayer/meta-transaction/paymaster setup, e.g. ERC-4337
// account abstraction) can have a third-party address broadcast and pay gas
// for many different "independent" wallets' actions, while every one of them
// has a completely clean, unrelated, one-time funder — dodging every
// funding-graph signal in this codebase entirely, because none of them look
// at who pays gas, only at who sends money.
//
// Confirmed real and buildable 2026-08-21, not assumed: Ankr's
// `ankr_getTransactionsByHash` (walletActivity.js's getTransactionByHash)
// returns a transaction's raw `from` field, the actual broadcaster/gas payer,
// which can differ from a decoded ERC-20 transfer's `fromAddress` (the
// logical token sender) when the wallet is acting through a relayer.
//
// Mirrors circularFunding.js's shape: capped lookups (cost control, this is a
// bonus signal, not the load-bearing one), never throws, degrades to "no
// evidence found" on any error.

// How many of the wallet's own outbound token transfers to check. Each one
// costs its own getTransactionByHash round-trip, so this is deliberately
// small — same reasoning as circularFunding.js's
// MAX_OUTBOUND_COUNTERPARTIES_TO_TRACE. The first sponsored transaction found
// is enough evidence; there's no need to exhaustively prove every single one
// was sponsored.
const MAX_TRANSFERS_TO_CHECK = 5;

/**
 * Checks whether `wallet`'s own outbound ERC-20 activity was actually
 * broadcast (and gas-paid) by a different address. Walks a small, capped set
 * of the wallet's most recent outbound token transfers and, for each,
 * compares the decoded transfer's logical sender (`wallet`) against the
 * underlying transaction's real `from` (the broadcaster). Returns the first
 * mismatch found.
 *
 * Native transfers are deliberately not checked here: a native transfer's
 * `from` IS the gas payer by construction (you can't natively send OKB from
 * an address without that same address paying its own gas) — there is no
 * "sponsor" concept to detect on the native path, only on a relayed/AA
 * ERC-20 path where the on-chain broadcaster and the logical token sender
 * can legitimately differ.
 *
 * @param {string} wallet
 * @param {(address: string, opts: { pageSize: number }) => Promise<{ transfers?: Array<{ fromAddress?: string, transactionHash?: string }> }>} fetchTokenTransfers
 * @param {(hash: string) => Promise<{ from?: string } | null>} fetchTransactionByHash
 * @returns {Promise<{ sponsor: string, matchedTxHash: string } | null>}
 */
export async function detectGasSponsor(wallet, fetchTokenTransfers, fetchTransactionByHash) {
  const key = wallet.toLowerCase();

  try {
    const data = await fetchTokenTransfers(wallet, { pageSize: 100 });
    const outbound = (data?.transfers ?? []).filter(
      (t) => t.fromAddress?.toLowerCase() === key && t.transactionHash
    );

    for (const transfer of outbound.slice(0, MAX_TRANSFERS_TO_CHECK)) {
      const tx = await fetchTransactionByHash(transfer.transactionHash);
      const broadcaster = tx?.from?.toLowerCase();
      if (broadcaster && broadcaster !== key) {
        return { sponsor: broadcaster, matchedTxHash: transfer.transactionHash };
      }
    }

    return null;
  } catch {
    // Bonus signal, same convention as knownExchanges.js/circularFunding.js —
    // a transient fetch error means "no evidence this time," not a failure.
    return null;
  }
}
