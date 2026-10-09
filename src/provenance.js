// Funding provenance for an ERC-8004 agent's raters on Arc.
//
// The question this answers is not "does this agent have good reviews". The
// registry already shows that. The question is where the raters' money came
// from, because that is the one part of a reputation a farm cannot fake
// without moving real USDC through addresses that stay on chain afterwards.
//
// Ported from the Monad build of Headwater. The rules are the same; the data
// comes from the saved Arc payments list instead of an indexer (see
// src/arcData.js). Three rules are deliberately different from the obvious
// version:
//
//   1. Two hops, not one. Checking only owner -> rater is defeated by any farm
//      that puts one burner wallet in the middle. owner -> X -> rater costs one
//      more lookup and closes that route.
//   2. Owner identity beats distributor shape. A wallet that paid a great many
//      others looks like a public faucet, and a faucet links nobody. But if that
//      wallet is the agent's own owner, the identity is what matters.
//   3. A rater that is a contract is not a person. Application contracts that
//      write game outcomes record one positive and one negative score, which is
//      a winner and a loser. Calling that manipulation would be wrong, so the
//      classifier names it instead.

let RPC_URL = "https://rpc.mainnet.arc.io";
export function setRpcUrl(url) { RPC_URL = url; }

// Numbers the verdict text quotes about the chain as a whole. Set once by the
// API build from the saved data, so no sentence below carries a stale count.
export const chainStats = { registered: 0, rated: 0, thin: 0, paidBeforeAcrossChain: 0 };

// The funding lookups below were written against an indexer's GraphQL
// endpoint. On Arc the same two questions are answered from the saved
// payments list, so the caller supplies a function with that shape.
let graphql = async () => ({ WalletFunder: [] });
export function setGraphql(fn) { graphql = fn; }

// Function selectors that identify a rating contract as an application
// writing outcomes rather than an opinion about service quality. A selector
// appears in a contract's dispatcher as a literal 4-byte push, so a substring
// search over the deployed code is enough to recognise one without an ABI.
// Found on Monad (game contracts); an Arc rater that is a contract but does
// not expose these is reported as a contract, never as an application.
const APP_SELECTORS = {
  "48e837b9": "createGame(uint256)",
  "117a5b90": "games(uint256)",
  "39ec68a3": "getRound(uint256,uint256)",
};

// How many raters to classify over RPC. Contract detection is one request per
// address, so a very large rater set would be thousands of requests. A sample answers the question the
// verdict actually asks ("are these raters people or code") and the number
// sampled is always reported next to the result, so a reader can see the
// claim's basis rather than trusting a round number.
const MAX_CLASSIFY = 40;

async function rpcCall(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// Returns Map(address -> { isContract, app }) where `app` names the
// application a rating contract belongs to, or null if it is code we cannot
// identify. An address that fails to resolve is simply absent from the map
// rather than guessed at, so a flaky RPC weakens the answer instead of
// falsifying it.
async function classifyRaters(addresses) {
  const out = new Map();
  const sample = addresses.slice(0, MAX_CLASSIFY);
  const results = await Promise.allSettled(
    sample.map(async (addr) => {
      const code = await rpcCall("eth_getCode", [addr, "latest"]);
      // An ordinary wallet that has switched on a smart-wallet add-on
      // (EIP-7702) also returns code: 0xef0100 followed by the address of the
      // add-on. It is still a person's wallet with its own key, so counting it
      // as a contract would tell a reader that people are software. The raters
      // of agents 10167 to 10262 and of agent 4 were described that way until
      // 2026-10-06.
      const isSmartWallet = typeof code === "string" && code.toLowerCase().startsWith("0xef0100");
      const isContract = typeof code === "string" && code.length > 2 && !isSmartWallet;
      let app = null;
      if (isContract) {
        const hits = Object.entries(APP_SELECTORS)
          .filter(([sel]) => code.includes(sel))
          .map(([, sig]) => sig);
        if (hits.length > 0) app = hits;
      }
      return [addr, { isContract, isSmartWallet, app }];
    }),
  );
  for (const r of results) if (r.status === "fulfilled") out.set(r.value[0], r.value[1]);
  return { classified: out, sampled: sample.length, total: addresses.length };
}

// One WalletFunder lookup for a set of wallets. Returns Map(wallet -> [{funder,
// isDust}]). Dust is kept rather than dropped: a gas top-up does not prove who
// capitalised a wallet, but it is still a link between two parties and the
// caller decides what weight to give it.
async function fundersOf(wallets) {
  if (wallets.length === 0) return new Map();
  const map = new Map();
  // Batched and paged, the way the indexer endpoint this was written against
  // required. Kept so the same code answers from the saved Arc list.
  const BATCH = 500;
  const PAGE = 1000;
  for (let i = 0; i < wallets.length; i += BATCH) {
    const batch = wallets.slice(i, i + BATCH);
    for (let offset = 0; ; offset += PAGE) {
      const query = `
        query Funders($wallets: [String!]!, $offset: Int!) {
          WalletFunder(where: { wallet: { _in: $wallets } }, limit: ${PAGE}, offset: $offset, order_by: { id: asc }) {
            wallet
            funder
            isDust
          }
        }`;
      const data = await graphql(query, { wallets: batch, offset });
      const rows = data.WalletFunder || [];
      for (const row of rows) {
        if (!map.has(row.wallet)) map.set(row.wallet, []);
        map.get(row.wallet).push({ funder: row.funder, isDust: row.isDust });
      }
      if (rows.length < PAGE) break;
    }
  }
  return map;
}

// Did the rater ever pay the agent's owner, and did it pay before or after
// rating?
//
// A rating from somebody who actually paid for the service ought to be worth
// more than a rating from a stranger. But money can also go out from the owner
// and come back: the owner funds a wallet, the wallet rates the agent, and the
// wallet sends the balance back. Taken alone, "this rater paid the agent" would
// certify that wallet as a customer. So the payment is recorded with its
// direction and its timing, never as a bare yes or no. A payment also only
// counts as a customer's once the agent is registered; money sent before that
// pays for the wallet to exist.
//
// One stated limit: the saved list keeps the earliest payment from each payer
// to each wallet, so "paid before rating" means the payer's FIRST payment to
// the owner predates its first rating.
//
// Times here are block numbers.
async function tracePayments(owner, raterIds, firstRatedAt, registeredAt) {
  const ownerLc = (owner || "").toLowerCase();
  const raters = raterIds.map((r) => r.toLowerCase());
  if (!ownerLc || raters.length === 0) {
    return { paidBefore: [], paidAfter: [], paidUnknownTime: [], paidBeforeAgentExisted: [], tracedRaters: raters.length };
  }

  // Same two caps as fundersOf: at most 1,000 rows come back however large a
  // limit is asked for, and a very long `_in` list fails the whole query. So
  // the raters go out in batches and each batch is walked to exhaustion.
  const BATCH = 500;
  const PAGE = 1000;
  const paidBefore = [];
  const paidAfter = [];
  const paidUnknownTime = [];
  const paidBeforeAgentExisted = [];
  const born = registeredAt === undefined || registeredAt === null ? null : Number(registeredAt);

  for (let i = 0; i < raters.length; i += BATCH) {
    const batch = raters.slice(i, i + BATCH);
    for (let offset = 0; ; offset += PAGE) {
      const query = `
        query Payments($owner: String!, $raters: [String!]!, $offset: Int!) {
          WalletFunder(
            where: { wallet: { _eq: $owner }, funder: { _in: $raters } },
            limit: ${PAGE}, offset: $offset, order_by: { id: asc }
          ) {
            funder
            isDust
            valueRaw
            firstFundedTimestamp
          }
        }`;
      const data = await graphql(query, { owner: ownerLc, raters: batch, offset });
      const rows = data.WalletFunder || [];
      for (const row of rows) {
        const rater = (row.funder || "").toLowerCase();
        const record = {
          rater,
          isDust: row.isDust,
          valueRaw: row.valueRaw,
          paidAt: row.firstFundedTimestamp,
        };
        const ratedAt = firstRatedAt ? firstRatedAt.get(rater) : undefined;
        if (ratedAt === undefined || row.firstFundedTimestamp === undefined || row.firstFundedTimestamp === null) {
          paidUnknownTime.push(record);
        } else if (born !== null && Number(row.firstFundedTimestamp) < born) {
          paidBeforeAgentExisted.push(record);
        } else if (row.firstFundedTimestamp <= ratedAt) {
          paidBefore.push(record);
        } else {
          paidAfter.push(record);
        }
      }
      if (rows.length < PAGE) break;
    }
  }

  return { paidBefore, paidAfter, paidUnknownTime, paidBeforeAgentExisted, tracedRaters: raters.length };
}


// Traces owner money to raters over one and two hops.
//
// Hop one is the direct `owner -> rater` payment. Hop two is
// `owner -> intermediary -> rater`, which is what a farm produces the moment
// it stops paying its raters from the same wallet that registered the agent.
// Only the funders actually seen at hop one are followed, so the second query
// stays small.
// Splits review senders into the owner and everyone else. A smart wallet or a
// contract can have its review sent, and paid for, by another address. When
// that address is the agent's own owner, the review is the owner's, written
// through a wallet that never paid for anything itself. `senders` maps a rater
// to the set of addresses that sent its reviews, and holds only senders that
// differ from the rater.
function splitSenders(owner, senders) {
  const ownerLc = (owner || "").toLowerCase();
  const ownerSent = [];
  const otherSenders = new Map();
  for (const [rater, set] of senders || new Map()) {
    if (rater === ownerLc) continue;
    if (set.has(ownerLc)) ownerSent.push(rater);
    const others = [...set].filter((a) => a !== ownerLc);
    if (others.length > 0) otherSenders.set(rater, others);
  }
  return { ownerSent, otherSenders };
}

async function traceOwnerFunding(owner, raterIds, senders) {
  const ownerLc = (owner || "").toLowerCase();
  const raters = raterIds.map((r) => r.toLowerCase());
  const hop1 = await fundersOf(raters);
  // Whoever sent and paid for a review stands in the funder position for it,
  // so an owner who funded that sender is found at the second hop like any
  // other intermediary. The owner itself sending is reported separately, as
  // the owner's own review, not as funding.
  const { otherSenders } = splitSenders(owner, senders);
  for (const [rater, list] of otherSenders) {
    if (!hop1.has(rater)) hop1.set(rater, []);
    for (const sender of list) hop1.get(rater).push({ funder: sender, isDust: false, viaSender: true });
  }

  const direct = [];
  const viaCandidates = new Map(); // intermediary -> raters it funded
  for (const [wallet, rows] of hop1) {
    for (const row of rows) {
      const funder = (row.funder || "").toLowerCase();
      if (funder === ownerLc) {
        direct.push({ rater: wallet, isDust: row.isDust });
      } else if (funder) {
        if (!viaCandidates.has(funder)) viaCandidates.set(funder, []);
        viaCandidates.get(funder).push(wallet);
      }
    }
  }

  // Who funded the intermediaries. If the agent's own owner shows up here,
  // the raters were paid for by the owner through a wallet that exists only
  // to break the direct link.
  const hop2 = await fundersOf([...viaCandidates.keys()]);
  const indirect = [];
  for (const [intermediary, rows] of hop2) {
    if (!rows.some((r) => (r.funder || "").toLowerCase() === ownerLc)) continue;
    for (const rater of viaCandidates.get(intermediary) || []) {
      indirect.push({ rater, via: intermediary });
    }
  }

  return {
    direct,
    indirect,
    tracedRaters: raters.length,
    ratersWithKnownFunder: hop1.size,
  };
}

// Builds the plain-language verdict shown above every other signal.
//
// Every branch states what was observed, never why anyone did it. "The owner
// paid for these raters" is checkable. "These reviews are fake" is a claim
// about somebody's intent, is not checkable, and was wrong the one time this
// project tried it.
function buildVerdict({ owner, reviewers, feedbackCount, funding, raterTypes, selfRated, payments, rings, agentId, ownerSent }) {
  const findings = [];
  // Absent payment data is not the same as no payments, so an older caller
  // that does not supply it gets an empty record and no payment claim is made
  // in either direction.
  const pay = payments || { paidBefore: [], paidAfter: [], paidUnknownTime: [], tracedRaters: 0 };
  // Same reasoning for rings: a caller that has not loaded the chain-wide view
  // gets no ring claim either way, rather than an implied "no ring".
  const myRings = rings || [];

  if (feedbackCount === 0) {
    return {
      label: "NO EVIDENCE",
      tone: "mut",
      summary:
        "This agent has never been rated. That is the normal case on Arc: " +
        `only ${chainStats.rated} of ${chainStats.registered} registered agents have any feedback. There is ` +
        "nothing here to trust or distrust.",
      findings,
    };
  }

  const appRaters = [...raterTypes.classified.entries()].filter(([, v]) => v.app);
  const contractRaters = [...raterTypes.classified.entries()].filter(([, v]) => v.isContract);

  if (funding.direct.length > 0) {
    findings.push(
      `${funding.direct.length} of ${funding.tracedRaters} raters were paid directly by this agent's own owner.`,
    );
  }
  // A rater can be paid both directly and through a wallet. It is one rater,
  // so the "more" below counts only raters not already counted as direct.
  const directSet = new Set(funding.direct.map((d) => d.rater));
  const indirectOnly = funding.indirect.filter((i) => !directSet.has(i.rater));
  if (indirectOnly.length > 0) {
    const vias = new Set(indirectOnly.map((i) => i.via));
    findings.push(
      `${new Set(indirectOnly.map((i) => i.rater)).size} more were paid by the owner through ${vias.size} ` +
        `intermediary wallet${vias.size === 1 ? "" : "s"}, which a direct owner-to-rater check does not see.`,
    );
  }
  // Money that left the owner and came back. Stated as a movement, because
  // that is all it is: the owner funded the rater, the rater rated, the rater
  // returned funds to the owner. Why anyone did that is not knowable from the
  // chain and is not claimed here.
  const ownerFundedSet = new Set([
    ...funding.direct.map((d) => d.rater),
    ...funding.indirect.map((i) => i.rater),
  ]);
  const roundTrip = pay.paidAfter.filter((p) => ownerFundedSet.has(p.rater));
  if (roundTrip.length > 0) {
    findings.push(
      `${roundTrip.length} rater${roundTrip.length === 1 ? " was" : "s were"} funded by this ` +
        `agent's owner and then sent funds back to that same owner after rating. The owner's ` +
        "money made a round trip.",
    );
  }
  const independentPaidBefore = pay.paidBefore.filter((p) => !ownerFundedSet.has(p.rater));
  if (independentPaidBefore.length > 0) {
    findings.push(
      `${independentPaidBefore.length} rater${independentPaidBefore.length === 1 ? "" : "s"} ` +
        `paid this agent's owner BEFORE rating it and ${independentPaidBefore.length === 1 ? "was" : "were"} ` +
        "not funded by that owner. That is the strongest grounding available here, and it is rare: " +
        `${chainStats.paidBeforeAcrossChain} such relationship${chainStats.paidBeforeAcrossChain === 1 ? " exists" : "s exist"} across the whole chain.`,
    );
  }
  const setUp = (pay.paidBeforeAgentExisted || []).length;
  if (setUp > 0) {
    findings.push(
      `${setUp} rater${setUp === 1 ? "" : "s"} sent money to the owner's wallet before this agent was ` +
        "registered, then rated it. That pays for the wallet to exist. It is not a customer paying for a service.",
    );
  }
  if (pay.paidAfter.length > 0 && roundTrip.length === 0) {
    findings.push(
      `${pay.paidAfter.length} rater${pay.paidAfter.length === 1 ? "" : "s"} paid this agent's ` +
        "owner, but only after rating it.",
    );
  }
  if (selfRated > 0) findings.push("The owner's own wallet is among the raters.");
  // Absent sender data makes no claim either way, same as payments and rings.
  const proxied = ownerSent || [];
  if (proxied.length > 0) {
    findings.push(
      `${proxied.length} rater wallet${proxied.length === 1 ? "" : "s"} did not send ${proxied.length === 1 ? "its" : "their"} ` +
        `own review. This agent's owner sent and paid for the review transaction, so ${proxied.length === 1 ? "that review is" : "those reviews are"} ` +
        "the owner's, written through another address.",
    );
  }
  if (appRaters.length > 0) {
    findings.push(
      `${appRaters.length} of the ${raterTypes.sampled} raters checked are application contracts, not people. ` +
        `They expose ${appRaters[0][1].app.join(", ")}, so these scores are outcomes recorded by software.`,
    );
  } else if (contractRaters.length > 0) {
    findings.push(
      `${contractRaters.length} of the ${raterTypes.sampled} raters checked are contracts rather than wallets.`,
    );
  }
  if (reviewers.length === 1) findings.push("Every rating came from one single address.");
  for (const ring of myRings) findings.push(describeRing(ring, agentId));

  const ownerPaid = ownerFundedSet.size;

  // Whether the raters are mostly software decides which fact leads, because
  // the two readings call for opposite reactions. An owner paying strangers to
  // rate it is a reason to discount the score. An application recording its own
  // outcomes is the standard working, and the owner paying that application's
  // gas is unremarkable. Leading with "owner funded" on application-contract raters would
  // repeat this project's one serious mistake, so when most of the raters
  // checked are application contracts, that leads and the funding is reported
  // underneath rather than as a headline.
  const appMajority =
    raterTypes.sampled > 0 && appRaters.length >= Math.ceil(raterTypes.sampled / 2);

  if (appMajority) {
    return {
      label: "APP GENERATED",
      tone: "mut",
      summary:
        "These scores were written by application contracts recording outcomes, not by " +
        "people forming opinions. That is the standard being used as designed. It is not a " +
        "warning, but the score measures results inside one application rather than a " +
        "general reputation, and it should not be read as customers vouching for this agent." +
        (ownerPaid > 0
          ? " The owner has also funded raters here, which for an application contract usually " +
            "means paying its gas rather than buying an opinion."
          : ""),
      findings,
    };
  }
  // Ranked above OWNER FUNDED because it says strictly more: not only did the
  // owner pay for the raters, the money came back. It stays below APP
  // GENERATED, because an application contract paid its gas and returning a
  // balance is ordinary plumbing, and reading that as a round trip would
  // repeat this project's one serious mistake.
  if (roundTrip.length > 0) {
    const share = Math.round((roundTrip.length / Math.max(funding.tracedRaters, 1)) * 100);
    return {
      label: "ROUND TRIP",
      // Same reason as OWNER FUNDED: a half is a real finding and is not
      // painted the same as a whole.
      tone: share >= 50 ? "red" : "amber",
      summary:
        `${share}% of the traced raters were paid by this agent's own owner and then sent funds ` +
        "back to that same owner after rating it. The money left the owner and returned to the " +
        "owner. How much of it returned is not asserted here, only that it went both ways. This " +
        "describes where the money moved and not why anyone moved it, and a funded campaign can " +
        "be entirely legitimate. It does mean that a check asking only 'did the rater pay this " +
        "agent' would read this agent as customer-backed, which the direction and the timing of " +
        "the money both contradict.",
      findings,
    };
  }
  if (ownerPaid > 0) {
    const share = Math.round((ownerPaid / Math.max(funding.tracedRaters, 1)) * 100);
    return {
      label: "OWNER FUNDED",
      // A minority share is a real finding but not the whole picture, so it is
      // not dressed in the same colour as an agent whose entire rater base was
      // paid for by the party being rated.
      tone: share >= 50 ? "red" : "amber",
      summary:
        `Money for ${share}% of the traced raters came from the agent's own owner. That is ` +
        "not an accusation of fraud, and a paid campaign can be perfectly legitimate. It does " +
        "mean that much of the score is not independent evidence, because the party being " +
        "rated paid for those raters to exist.",
      findings,
    };
  }
  if (selfRated > 0 || proxied.length > 0) {
    return {
      label: "SELF REVIEWED",
      tone: "red",
      summary:
        selfRated > 0
          ? "The wallet that owns this agent is among the wallets rating it." +
            (proxied.length > 0
              ? ` It also sent ${proxied.length} more review${proxied.length === 1 ? "" : "s"} through other wallets.`
              : "")
          : `This agent's own owner sent ${proxied.length === 1 ? "the review" : `${proxied.length} of the reviews`} ` +
            "on it, through a separate wallet that never paid for anything itself. Comparing the " +
            "reviewer's address with the owner's address misses this, because the addresses differ. " +
            "The transaction that carried the review shows who actually sent it.",
      findings,
    };
  }
  // Below OWNER FUNDED and SELF REVIEWED, because the owner paying for raters
  // or rating itself is the more direct fact when both are true. Above THIN,
  // because THIN describes one agent and misses what makes these cases notable: each agent on its own looks
  // ordinary, often a single review, and only the group shows the pattern.
  if (myRings.length > 0) {
    const biggest = myRings[0];
    return {
      label: "RING",
      tone: "amber",
      summary:
        `This agent's ratings trace to a group that also rated ${biggest.agents.length - 1} other ` +
        "agents. Looked at alone, this agent's reviews seem ordinary. Looked at across the chain, " +
        "the same money source sits behind all of them. That describes where the money and the " +
        "ratings came from, not why, and a group of related agents can be perfectly legitimate. It " +
        "does mean these reviews are not independent of each other.",
      findings,
    };
  }
  if (reviewers.length === 1) {
    return {
      label: "THIN",
      tone: "amber",
      summary:
        "Every rating on this agent came from a single address. " +
        `${chainStats.thin} of the ${chainStats.rated} rated agents on Arc are in this position. One address agreeing with itself repeatedly is one ` +
        "opinion, however many times it is recorded.",
      findings,
    };
  }
  return {
    label: "NO LINK FOUND",
    tone: "mut",
    summary:
      `No funding link was found between this agent's owner and its raters, across ` +
      `both direct payments and one intermediary wallet. ${funding.ratersWithKnownFunder} of ` +
      `${funding.tracedRaters} raters have a funding record at all, so absence of a link is ` +
      "weaker evidence than a link would be.",
    findings,
  };
}

// Groups that reach across several agents, found from the whole chain at once.
//
// Everything above looks at one agent and its own raters, which cannot see a
// group that spreads itself thin: thirteen wallets each rating a different
// agent look like thirteen unrelated single ratings until you notice the same
// wallet paid all thirteen. That needs every rating and every funding record
// on the chain in one place, so it runs where those are already loaded (the
// API build and the MCP server) and the page reads the result from
// api/rings.json.
//
// Two shapes are reported:
//
//   1. One outside wallet funded the raters of several agents. The funder is
//      not those agents' owner, so the owner-funding check above does not see
//      it.
//   2. One rater covered several agents whose owners share a funder. Each of
//      those agents looks like an agent with one ordinary review.
//
// Two guards keep this from naming ordinary behaviour. A shared funder only
// counts on an agent where the wallets it funded are at least half of that
// agent's raters, so a public faucet that happens to have topped up a few
// raters here and there does not turn the chain into one ring. And a rater
// who reviews widely is not a ring by itself; it takes three or more agents
// whose owners all trace to the same funder.
const RING_MIN_AGENTS = 3;

function findRings({ feedback, agents, funders }) {
  const ownerOf = new Map(agents.map((a) => [String(a.id), a.owner.toLowerCase()]));
  const ratersOf = new Map();
  for (const f of feedback) {
    const id = String(f.agent_id);
    if (!ratersOf.has(id)) ratersOf.set(id, new Set());
    ratersOf.get(id).add(f.reviewer_id.toLowerCase());
  }
  // Dust is left out here. A gas top-up links two wallets, but it does not say
  // who paid for a wallet to exist, and a ring claim should rest on the money
  // that did.
  const fundedBy = new Map();
  for (const r of funders) {
    if (r.isDust) continue;
    const w = r.wallet.toLowerCase();
    if (!fundedBy.has(w)) fundedBy.set(w, new Set());
    fundedBy.get(w).add(r.funder.toLowerCase());
  }

  const rings = [];

  // Shape 1: funder -> agent -> raters it funded there.
  const byFunder = new Map();
  for (const [agentId, raters] of ratersOf) {
    for (const rater of raters) {
      for (const funder of fundedBy.get(rater) || []) {
        // The owner paying its own raters is OWNER FUNDED, already reported.
        if (funder === ownerOf.get(agentId)) continue;
        if (!byFunder.has(funder)) byFunder.set(funder, new Map());
        const m = byFunder.get(funder);
        if (!m.has(agentId)) m.set(agentId, new Set());
        m.get(agentId).add(rater);
      }
    }
  }
  for (const [funder, m] of byFunder) {
    const counted = [...m].filter(([agentId, funded]) => funded.size * 2 >= ratersOf.get(agentId).size);
    const raters = new Set(counted.flatMap(([, funded]) => [...funded]));
    // One funded wallet rating many agents is one rater, and shape 2 is the
    // place for that. A group needs at least two members.
    if (counted.length < RING_MIN_AGENTS || raters.size < 2) continue;
    rings.push({
      kind: "shared funder",
      source: funder,
      agents: counted.map(([id]) => id).sort((a, b) => a - b),
      raters: [...raters].sort(),
      owners: [...new Set(counted.map(([id]) => ownerOf.get(id)))].sort(),
    });
  }

  // Shape 2: rater -> funder of the owners it rated -> agents.
  const agentsRatedBy = new Map();
  for (const [agentId, raters] of ratersOf) {
    for (const rater of raters) {
      if (!agentsRatedBy.has(rater)) agentsRatedBy.set(rater, []);
      agentsRatedBy.get(rater).push(agentId);
    }
  }
  const family = new Map();
  for (const [rater, rated] of agentsRatedBy) {
    if (rated.length < RING_MIN_AGENTS) continue;
    const byOwnerFunder = new Map();
    for (const agentId of rated) {
      const owner = ownerOf.get(agentId);
      if (!owner || owner === rater) continue;
      // Same half-or-more rule as shape 1: on an agent with many raters, one
      // of them is not the agent's reputation.
      if (ratersOf.get(agentId).size > 2) continue;
      for (const funder of fundedBy.get(owner) || []) {
        if (funder === rater) continue;
        if (!byOwnerFunder.has(funder)) byOwnerFunder.set(funder, new Set());
        byOwnerFunder.get(funder).add(agentId);
      }
    }
    for (const [funder, ids] of byOwnerFunder) {
      const owners = new Set([...ids].map((id) => ownerOf.get(id)));
      if (owners.size < RING_MIN_AGENTS) continue;
      // Two raters working the same family are one ring, not two, so rings
      // with the same source are merged.
      const same = family.get(funder);
      if (same) {
        same.raters.add(rater);
        for (const id of ids) same.agents.add(id);
      } else {
        family.set(funder, { raters: new Set([rater]), agents: new Set(ids) });
      }
    }
  }
  for (const [funder, { raters, agents: ids }] of family) {
    rings.push({
      kind: "one rater, one family of owners",
      source: funder,
      agents: [...ids].sort((a, b) => a - b),
      raters: [...raters].sort(),
      owners: [...new Set([...ids].map((id) => ownerOf.get(id)))].sort(),
    });
  }

  return rings.sort((a, b) => b.agents.length - a.agents.length);
}

// The plain sentence for one ring, as seen from one of its agents.
function describeRing(ring, agentId) {
  const others = ring.agents.filter((id) => id !== String(agentId)).length;
  const funder = `${ring.source.slice(0, 10)}...`;
  if (ring.kind === "shared funder") {
    return (
      `Wallet ${funder} funded ${ring.raters.length} raters that rated ${ring.agents.length} agents, ` +
      `this one and ${others} other${others === 1 ? "" : "s"}. It is not this agent's owner, so a ` +
      "check that only follows the owner's money would miss it."
    );
  }
  return (
    (ring.raters.length === 1
      ? `The wallet that rated this agent also rated ${others} other${others === 1 ? "" : "s"}`
      : `This agent's rater is one of ${ring.raters.length} wallets that between them rated ${ring.agents.length} agents`) +
    `, and the owners of all ${ring.agents.length} were funded by the same wallet, ${funder} Each agent looks like it has one ordinary review until they are ` +
    "put side by side."
  );
}

export { classifyRaters, traceOwnerFunding, tracePayments, buildVerdict, findRings, splitSenders, describeRing };
