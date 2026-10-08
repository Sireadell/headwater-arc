# What is real and what is limited

A plain list of what Headwater on Arc actually does, what it checked itself, and where it falls short.

## Real

| Piece | What makes it real |
|---|---|
| Registry reads | `src/core/rpc/erc8004Registry.js` calls the live ERC-8004 Identity and Reputation registries on Arc mainnet (`0x8004A169...`, `0x8004BAa1...`). Agent ids 0 to 2313 exist, and 116 of them have reviews |
| Payments | Every USDC move on Arc writes one log from the system address `0xffff...fffe`. Headwater reads those logs, and divides the 18-digit amount by 10^12 to get normal 6-digit USDC |
| Hand checks | Agent 346 (owner paid both reviewers) and agent 8 (owner paid its reviewer 1 USDC) were checked against the chain's own receipts. From, to and amount matched |
| Records on Arc | 16 transactions on Arc mainnet, one per flagged agent, each carrying the agent id, flagged reviewers and funding transaction as readable text. All 16 were read back and matched |
| Tests | `npm test`, 111 tests, all pass. Only 5 of them cover code the audit runs (the Arc payment reader). The other 106 cover the older funding signals in `src/core/signals/`, which the audit script does not use |

## Limits, stated plainly

| Limit | What it means |
|---|---|
| Only first funding is followed | Up to two steps back from each wallet. A reviewer funded another way shows no link |
| Window starts at block 10,000,000 | Payments before that are not in view. The payment log is empty in the first 5,000,000 blocks and nearly empty around 10,000,000, so little is lost, but I can't prove nothing earlier matters |
| 4 reviewers have no funder found | 0xfcef1558, 0x30906ffd, 0xd45aa349, 0x4fa208eb. They show no link either way |
| Busy wallets are set aside | 9 wallets with thousands of payments (exchanges, bridges, faucets). Being paid by one links you to nobody. If one is the agent's own owner, it still counts |
| A link is not a verdict | It means money moved from one wallet to another. It does not show intent, and it does not say anyone cheated |
| The big reviewer | 0x6a663f... reviewed 87 of the 116 agents. None of its reviews link to the agent's owner, so it looks like a service or bot. I don't claim more than that |
| My own wallet | The wallet that wrote the records (0xb3FB...2B53) left one review, on agent 192, and was also the first to send money to agent 192's owner (0.0012 USDC, tx 0xe38ec6ca...d9072). The check does not look at money going from a reviewer to an owner, so it did not flag this. It is a link |
| One direction only | Money from a reviewer to the owner is not checked, and neither are reviewers who review each other's agents. A hand test found cases: agents 134 and 289 (and 192, above) show no link although a reviewer paid the owner, and agents 133 and 205 are flagged as 'same funder' when the reviewer actually paid the owner. Those are outside what this version reports |
| No second opinion | No wallet-label service is used. Headwater reads the chain only |

## Not built

| Piece | Why |
|---|---|
| Monitoring new reviews | The audit is a snapshot, rerun by hand with the two scripts in the README |
| Records for the 100 unflagged agents | Only the 16 with links were written on Arc. The page lists the rest as "no link found" |
| Unit tests for `scripts/auditArc.mjs` | Its rules were checked by hand on real agents, not by an automated test |

## Where the code came from

The funding signals in `src/core/signals/` were first written for an earlier project of mine and reused here. The Arc payment reader (`src/core/rpc/arcClient.js`), the saved-payments builder, the audit script, and the page are new for Arc.
