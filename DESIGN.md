# Driftgold: design notes

## Pitch
Gold drifts into a handful of coves. Each round every captain secretly picks one cove and how many oars
to row there. Alone, you take the gold for free. Where captains meet, the most oars wins the gold but
hands those oars to the captains it beat, who can use them to win a bigger fight later. Everyone moves at
once, so 8 rounds take a few minutes, and humans, agents and bots share one table.

## Rules (the one paragraph shown in the game, the API and the README)
Each captain starts with 10 oars and no gold. Each round, everyone secretly picks one cove and how many
oars to row there (0 up to all they have); all picks are revealed together. Alone at a cove, you take its
gold and keep your oars. Where captains meet, the most oars takes the cove's gold and hands the oars it
rowed to the captains it beat, split evenly (odd oars sink). A tie for most oars goes to the captain with
less gold; if still tied, nobody takes the cove. Coves nobody took gain 1 to 3 gold with the tide; a taken
cove restarts at 1. There is one more cove than captains, play lasts 8 rounds, the last round pays double,
and the most gold wins (oars left break a tie).

Setup: 2-4 captains, players+1 coves holding 1..N gold in a shuffled order. The tide is random but fixed
by the match seed, so a match replays exactly from its log.

## Why every turn is a decision
- **Where**: the richest cove draws a crowd. A quiet cove pays less but pays for free.
- **How many oars**: oars you row are only spent if you win, and they go to the captains you beat. Row
  too few and you lose the cove; row too many and you arm your rivals for the next fight.
- **Two currencies**: gold is the score, oars are only power. Taking gold costs future power; being
  beaten builds power. Converting one into the other at the right moment is the game.
- **Timing**: round 8 pays double and oars are worthless after it, so saving oars for the end is a real
  plan, and so is forcing a saver to spend early.

## Comeback and tension
- Every lost fight pays you oars, so the trailing captain ends up with the most power.
- Ties go to the captain with less gold, so the trailing captain wins every even fight.
- Neglected coves keep growing with the tide, so a crowd on one cove leaves gold elsewhere.
- In simulation the average winning margin between two house bots is 4-6 gold, with a double-pay last
  round worth 2-16 gold, so the last round regularly decides the match.

## Balance evidence (sim/balance.mjs, fixed seeds; raw numbers in sim/balance.json)
Simple fixed plans, each a few lines in `src/bots.js`:

| Plan | What it does |
|---|---|
| Bully | leans hard toward rich coves, rows 40-70% of its oars |
| Fair | mild lean toward value, rows about half the cove's gold |
| Steady | always the richest cove, rows half its gold |
| Topper | always the richest cove, rows half its gold plus one |
| Raider | always the richest cove, rows half its gold plus two |
| Patient | rows nothing (collecting oars) until it holds more oars than every rival, then fights for the richest cove; all in on the last round |
| Dodger, Shark, Banker, All-in, Random | weaker reference plans (avoid crowds / never row / save then strike / always all in / random) |

**4 players** (2,010 matches: every table of four different plans from Bully, Fair, Steady, Topper,
Patient, Raider; target: no plan above ~45%):

| Bully | Fair | Steady | Topper | Patient | Raider |
|---|---|---|---|---|---|
| 39.1% | 23.2% | 10.6% | 29.9% | 31.8% | 15.4% |

**2 players** (2,001 matches: every pairing of the three plans that contest the richest cove; target:
no plan above ~60%):

| Steady | Topper | Patient |
|---|---|---|
| 55.6% | 35.3% | 59.1% |

Head to head they go round in a circle: Patient beats Topper 81%, Steady beats Patient 63%, Steady and
Topper split 49/51. Every simple plan has a simple counter.

**Against the house bot** (500 matches per cell; the house bot is the Reader described below):

| Plan | vs 3 house bots (fair share 25%) | vs 1 house bot (fair share 50%) |
|---|---|---|
| Bully | 19.5% | 16.2% |
| Fair | 9.0% | 11.7% |
| Steady | 3.8% | 31.0% |
| Topper | 9.6% | 39.2% |
| Raider | 15.9% | 21.3% |
| Patient | 11.2% | 32.5% |
| Dodger | 3.6% | 2.2% |
| Shark | 1.8% | 2.4% |
| Banker | 3.0% | 2.0% |
| All-in | 5.7% | 1.8% |
| Random | 7.8% | 1.2% |

No fixed plan reaches its fair share against the house bot, at either table size: a habit gets read and
punished. House bot self-play: 4 seats 22.8 / 23.9 / 31.6 / 21.7% (the seats have different
temperaments), 2 seats 53.5 / 46.5%.

For completeness, every plan against every other plan, weak ones included (`allPlans4p`,
`allPlans2p` in the JSON): the strongest plans reach 51% (4p) and 87% (2p) because they feed on
Random, Shark, Dodger and Banker; among the competitive plans the circle above holds.

## The house bot ("Reader")
For every rival it keeps counts of which value rank of cove they pick and how many oars they row relative
to the cove's gold. Each turn it samples 40 likely rounds from those models, scores every (cove, oars)
option by gold gained plus oars gained (an oar is worth `rounds left / rounds` gold) relative to the
table, and picks with a softmax so it is not predictable. Each house seat has a temperament (more or
less noise, and one simple style mixed in 10% of the time) so a table of bots does not play as one.
It sees only public information: what every player sees.

## How the rules got here (what failed, measured with the same simulator)
1. Bids from a separate energy pool that refills, winner pays the bank: "richest cove, bid its value"
   won 78-96% at every table size.
2. One currency (gold is score and bid), winner pays its whole bid to the captains it beat: "richest
   cove, bid 0" won 87% at 4 players (it either takes the cove free or gets paid).
3. Winner pays the runner-up's bid (second price): bidding the full value won 98%, as auction theory
   predicts.
4. Winner's bid to the bank, or all-pay: avoiders won 65-88% at 4 players, big bidders 82-99% at 2.
5. One currency, half the bid to the beaten captains and half back into the cove: balanced at 4
   players, but at 2 players a fair-split bid on the richest cove can never lose ground, and "richest
   cove, bid half" beat every other plan 75-97%. Rejected: a dominant strategy at 2 players.
6. Separate oars that never refill and go to the captains you beat (this design): the fair-split bid
   no longer exists because oars are a budget, fights move power to the losers, and the final double
   round gives saved oars a purpose. With a fixed +2 growth the three richest-cove plans still played
   out identically every match (100/0 head to head); the random 1-3 tide breaks that, keeps the circle,
   and adds a little luck for casual tables.

## Scope and timing
- One Cloudflare Worker, one Durable Object per match (state, round timer as an alarm, seats, house bots).
- 2-4 seats, humans, agents and bots mixed. Empty seats become house bots on start.
- Round timer 40 s by default (10-120 s at create). A seat that misses it is played by the house bot for
  that round (marked `auto`). Worst case 8 x 40 s = 5 min 20 s; with prompt players about 1-2 minutes.
- Match log and replay come from the same history the engine produces.
- No login: the seat token returned on join is the only credential, kept in the browser's localStorage.

## Name
"Driftgold": a web search for `"Driftgold" game` on 2026-11-03 found no game with that name.
