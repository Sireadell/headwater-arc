# What is real and what is limited

A plain list of what Headwater on Arc actually does, what was checked, and where it falls short.

## Real

| Piece | What makes it real |
|---|---|
| Registry reads | `src/core/rpc/erc8004Registry.js` and `scripts/buildArcFeedback.mjs` read the live ERC-8004 Identity and Reputation registries on Arc mainnet (`0x8004A169...`, `0x8004BAa1...`). 2,316 agents are registered and 127 have reviews. Every review is saved with the wallet that sent its transaction |
| Payments | Every USDC move on Arc writes one log from the system address `0xffff...fffe`. `src/core/rpc/arcClient.js` reads those logs and divides the 18-digit amount by 10^12 to get normal 6-digit USDC |
| The verdict rules | `src/provenance.js` is a port of the Monad Headwater rules. The 29 tests that cover them (`provenanceVerdict`, `rings`, `reviewSender`, `smartWallet`) came across and pass unchanged. 7 more cover the secondary signals, 5 the payment reader. `npm test` runs 147 tests in all, and the older funding-signal tests in `src/core/signals/` are carried over too |
| Hand checks | Agent 346 (owner paid both reviewers) and agent 8 (owner paid its reviewer 1 USDC) were checked against the chain's own receipts. A separate tester rebuilt the first version of the audit from a fresh copy of the repo and got identical results for all 116 agents it covered, then re-checked 13 funding payments against receipts. The verdicts here were rebuilt after that and have not had a second independent check |
| Records on Arc | Findings are written to Arc mainnet as small transactions. Each carries the agent, its verdict and the transaction hashes of the payments behind it, as readable text. `scripts/writeMemos.mjs` reads each record back and skips any that already match |

## Limits, stated plainly

| Limit | What it means |
|---|---|
| Two funding hops | Owner to reviewer, and owner to one wallet to reviewer. A longer chain is not followed, so absence of a link is weaker evidence than a link |
| Window starts at block 10,000,000 | Payments before that are not in view. The payment log is empty in the first 5,000,000 blocks and nearly empty around 10,000,000, so little is lost, but I can't prove nothing earlier matters |
| Some reviewers have no funder found | Seven agent-and-reviewer pairs (agents 196, 1407 to 1411 and 1419). They show no link either way, and each verdict says how many reviewers have a funding record |
| Busy wallets are set aside | 9 wallets with thousands of payments (exchanges, bridges, faucets). Being paid by one links you to nobody. The agent's own owner is never set aside |
| A link is not a verdict | It means money moved from one wallet to another. It does not show intent, and it does not say anyone cheated |
| Small top-ups count | A small payment from an owner to a reviewer counts, and the lookup page marks it as a top-up. Many links look like a developer funding a test wallet. Read the amount |
| The big reviewer | 0x6a663f... reviewed 87 agents. None of its reviews are funded by the agent's owner, so it looks like a service or bot. I don't claim more than that |
| My own wallet | The wallet that wrote the records (0xb3FB...2B53) left one review, on agent 192, and was also the first to send money to agent 192's owner, before that agent was registered. Agent 192 is `THIN`, and its verdict names the payment |
| Rings and loops | Owners who review each other's agents are not detected when a busy wallet funded them all. A hand test found one such loop (agents 1407 to 1411) and one pair (the big reviewer and 0x246d064a on agents 211 and 228) |
| Payment timing | "Paid before rating" compares the payer's first payment to the owner against the payer's first review. A later payment by an already-paying wallet is not timed separately. Times are block numbers, about two a second |
| Wallets created together | Measured from each wallet's first incoming payment, not from its first transaction, because that is what the payments list holds |
| Code check is a sample | Up to 40 reviewers per agent are checked for contract code. The sample size is on every verdict |
| Snapshot, not live | Verdicts are rebuilt by hand. Only the newest-ratings feed on the home page reads Arc live, from Arc's public node |
| No second opinion | No wallet-label service is used. Headwater reads the chain only |

## Not built

| Piece | Why |
|---|---|
| Automatic refresh | Rerunning the three scripts by hand. A scheduled rebuild is the next step |
| Automatic records | New findings are written to Arc by hand, because doing it automatically would need a wallet key on a server |
| A quest or app-reward classifier for Arc | The Monad build recognised game contracts by their code. Arc has none that I found, so `APP GENERATED` is wired but has fired on no agent |

## Where the code came from

The verdict rules, the funding signals in `src/core/signals/`, and the MCP server shape were first written for the Monad version of Headwater and reused here. The Arc payment reader, the saved-payments and saved-reviews builders, the local data layer in `scripts/buildApi.mjs`, the secondary signals in `src/agentSignals.js`, and the site are new for Arc.
