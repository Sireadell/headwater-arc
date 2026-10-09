# Headwater on Arc

Headwater is a reputation context tool for ERC-8004 agents on Arc.

I built it because reviews can look trustworthy and still mislead people.

Most people already know this from normal internet life. A shop can have hundreds of five-star reviews and half of them came from the owner's own second accounts. A P2P trader can have a perfect profile and still shortchange you once real money is involved.

Agent reviews on Arc have the same problem, with more money on the line.

Arc keeps a public trail of reviews for each agent (the ERC-8004 registry). A score on its own doesn't tell you who gave it. Headwater asks the one question the score doesn't answer:

```txt
Before I trust this agent, what is its reputation actually made of?
```

Headwater does not call anything fraud and does not guess what anyone meant. It reads the public payments behind the reviewers and gives each agent one plain verdict. When an agent's owner paid for its reviewers, it shows you the payment. What that means is up to you.

This is the Arc version of Headwater, my Monad project. The verdict rules are the same, and the tests that cover them came across and pass unchanged. What differs is where the data comes from: Arc's own payment log instead of an indexer.

## What it found on Arc

Arc has 2,316 registered agents. 127 of them have any review at all. Headwater read all of them.

| Verdict | Agents | What it means |
|---|---|---|
| `NO EVIDENCE` | 2,189 | No reviews yet |
| `THIN` | 85 | Every review came from one single address |
| `RING` | 15 | One reviewer, or one money source, sits behind several agents that each look like they have one ordinary review |
| `OWNER FUNDED` | 14 | The agent's own owner paid for its reviewers, directly or through one wallet |
| `NO LINK FOUND` | 9 | More than one reviewer and no funding link found |
| `ROUND TRIP` | 2 | The owner paid the reviewers, and money came back to the owner after the rating (agents 196 and 203) |
| `SELF REVIEWED` | 2 | The owner sent the review through another wallet (agents 223 and 1419) |

These are evidence labels, not accusations. A paid campaign can be legitimate, and a developer funding a test wallet looks the same on the chain.

Open the [live page](https://sireadell.github.io/headwater-arc/), type an agent number, and you'll see the verdict, the reasons, every payment behind it with an explorer link, and seven smaller signals.

## You can check my work on Arc itself

For each agent with a finding, I sent one small transaction on Arc mainnet from my wallet to itself, with no money moved. The note inside it is readable text: the agent, its verdict, and the transactions that show the payments.

So you don't have to trust my page. Open the record on Arc, open the payment named inside it, and see whether they match. On the explorer, click "View details" and switch the data to UTF-8 to read it. I checked agent 346 and agent 8 against the chain by hand, and a separate tester rebuilt the whole audit from scratch and got the same result for every agent.

## Why this needs Arc's payment log

On Arc, USDC is the coin that pays fees. A plain USDC send leaves no ordinary token log, so a normal token scan sees nothing. Arc's system address writes one log for every USDC move, and that is what Headwater reads. Without it, owner-to-reviewer payments are invisible. Arc's public node also limits how much history one request can read, so the scan runs through a Dwellir endpoint.

Headwater scans those logs once, saves the payments around the agents and their reviewers, and answers every check from that saved list.

## What it does not do

- It follows the money two steps back. A reviewer funded some longer way shows no link.
- Wallets that made thousands of payments (exchanges, bridges, faucets) are ignored as funders, because being paid by one links you to nobody. If such a wallet is the agent's own owner, it still counts.
- It starts at block 10,000,000. Payments before that are not in view.
- A few reviewers have no funding payment I could find. The verdict says how many.
- It can't see owners who review each other's agents in a loop when a busy wallet funded them all (agents 1407 to 1411 look like that).
- Small top-ups count. Many links are a developer funding a test wallet, and the lookup page marks them.
- One review on agent 192 came from my own wallet, the one I used to write the records. That wallet also sent money to agent 192's owner before the agent existed, which the verdict names. Agent 192 is `THIN`.
- It is a snapshot, rebuilt by hand. Only the newest-ratings feed on the home page reads Arc live.

See `HONESTY.md` for the full list.

## Use the API

No key. No server setup. The static API is published with the site.

```txt
GET https://sireadell.github.io/headwater-arc/api/index.json
GET https://sireadell.github.io/headwater-arc/api/agents/346.json
GET https://sireadell.github.io/headwater-arc/api/rings.json
```

An agent id with no file has never been rated, which is the verdict `NO EVIDENCE`, not an error.

## Use the MCP server

It lets an AI agent ask "what is this agent's reputation made of?" before it pays or trusts another agent. No dependencies.

Add it to any MCP client:

```json
{ "mcpServers": { "headwater-arc": { "command": "node", "args": ["/path/to/headwater-arc/mcp/server.mjs"] } } }
```

It reads the published reports by default. Set `HEADWATER_API` to a folder or URL to read your own copy.

## Run it yourself

Install dependencies:

```powershell
npm install
```

Save the payments around every reviewed agent (about 10 minutes, needs a Dwellir Arc URL in `.env` as `DWELLIR_ARC_URL`, or it falls back to Arc's public endpoint, which is much slower):

```powershell
node --env-file=.env scripts/buildArcIndex.mjs
```

Save every review and registration (about 3 minutes):

```powershell
node --env-file=.env scripts/buildArcFeedback.mjs
```

Work out the verdicts and write the API files in `docs/api`:

```powershell
node --env-file=.env scripts/buildApi.mjs
```

Run the tests:

```powershell
npm test
```

The site is the `docs` folder.

## Honesty notes

See `HONESTY.md` for what was and was not verified.

Headwater on Arc is an Arc Microgrants submission.

So, the question again: before you trust an agent, what is its reputation actually made of?
