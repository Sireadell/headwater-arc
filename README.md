# Headwater on Arc

Headwater is a check on who paid for the reviews of AI agents on Arc.

I built it because reviews can look trustworthy and still mislead people.

Most people already know this from normal internet life. A shop can have hundreds of five-star reviews and half of them came from the owner's friends and second accounts. A P2P trader can have a perfect profile and still shortchange you once real money is involved.

Agent reviews on Arc have the same problem, with more money on the line.

Arc keeps a public trail of reviews for each agent (the ERC-8004 registry). A rating on its own doesn't tell you who gave it. Headwater asks the one question the rating doesn't answer:

```txt
Did the people behind this agent pay for the reviews of this agent?
```

Headwater does not call anything fraud and does not guess what anyone meant. It reads the public payments, and when an agent's owner sent a reviewer its starting money, it shows you that payment. What it means is up to you.

## What it found on Arc

Arc has 2,314 registered agents. 116 of them have reviews. I checked all 116.

| Result | Agents |
|---|---|
| No money link found | 100 |
| Some reviewers linked to the owner's money | 10 |
| Every reviewer linked | 6 |

Open the [live page](https://sireadell.github.io/headwater-arc/), type an agent number, and you'll see the reviewers, the reason each was flagged, and the payment behind it.

## You can check my work on Arc itself

For each of the 16 agents with a link, I sent one small transaction on Arc mainnet from my wallet to itself, with no money moved. The note inside it is readable text: the agent number, the flagged reviewer wallets, and the transaction that funded each one.

So you don't have to trust my page. Open the record on Arc, open the funding payment named inside it, and see whether they match. I did this for agent 346 and agent 8, and both matched the chain exactly.

## Labels

| Label | Meaning |
|---|---|
| `self_review` | The reviewer is the agent's own owner or wallet |
| `paid_by_owner` | The owner sent the reviewer its starting money, directly or through one other wallet |
| `same_funder_as_owner` | The owner and the reviewer got their starting money from the same wallet |
| `shared_funder` | Several reviewers of one agent got their starting money from the same wallet |

These are evidence labels, not accusations. A friend can fund a friend's wallet for good reasons.

## What it does not do

- It only follows the first payment into a wallet, up to two steps back. A reviewer funded some other way will show no link.
- Wallets that made thousands of payments (exchanges, bridges, faucets) are ignored as funders, because being paid by one links you to nobody. If such a wallet is the agent's own owner, it still counts.
- 4 reviewers have no funding payment I could find, so they show no link either way.
- I scanned Arc from block 10,000,000. Payments before that are not in view.
- One review on agent 192 came from my own wallet (the one I used to write the records). That wallet was also the first to send money to agent 192's owner (0.0012 USDC). The check only looks at money going from the owner or a shared funder to a reviewer, so it did not flag this. It is a link, and I'm telling you.
- The check can't see money flowing from a reviewer to an owner, or reviewers who simply review each other's agents.

## How it reads Arc

On Arc, USDC is the coin that pays for fees, and a plain USDC send leaves no ordinary token log. Arc's system address writes one log for every USDC move, and that is what Headwater reads. It scans those logs once, saves the payments around the agents and reviewers, and answers every check from that saved list. A check takes no network calls.

The reads go through Dwellir, because Arc's public endpoint rate limits a scan this size. No outside indexer is used.

## Run it yourself

Install dependencies:

```powershell
npm install
```

Build the saved payments list. The next step needs it, and it takes about 10 minutes with a Dwellir Arc URL in `.env` as `DWELLIR_ARC_URL` (without one it falls back to Arc's public endpoint, which is much slower):

```powershell
node --env-file=.env scripts/buildArcIndex.mjs
```

Run the checks:

```powershell
node scripts/auditArc.mjs
```

Run the tests:

```powershell
npm test
```

The results land in `data/arc-audit.json`. The live page is in `docs/`.

## Honesty notes

See `HONESTY.md` for what was and was not verified.

Headwater is an Arc Microgrants submission.

So, the question again: before you trust an agent's reviews, did its owner pay for them?
