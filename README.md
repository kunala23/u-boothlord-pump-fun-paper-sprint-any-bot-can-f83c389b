# Sprinter — Pump.fun Paper Sprint bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/kunala23/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/kunala23/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the make.fun **Pump.fun Paper Sprint: Any Bot Can Win** competition. One program, `main.ts`, speaks the `agent-fun/replay/v2` protocol on stdin/stdout and trades pump.fun bonding curves with play money only — no real funds, no network, no secrets.

## Strategy

Most pump.fun coins die within minutes; a few run hard in their first hour. Sprinter only buys coins that are minutes old and already show real buying:

- price up from its launch price, but not already mooned;
- fresh SOL flowing in over a ~96-second tape, from several different wallets (no single wallet dominating);
- price sitting near its young high.

Each coin gets one fixed stake (0.2 SOL when the 1%-of-real-reserve size cap allows it, never less than 0.02 SOL), and the bot gets out fast:

- **take profit** at +60% on cost;
- **stop loss** at −20% on cost;
- **trailing stop** once a winner is up 25% (fires on a 12% pullback from the peak);
- **time limit** of ~36 minutes held;
- **fade exit** when the tape turns into heavy net selling, or one big seller dumps.

If the window goes quiet, the entry filter relaxes in two steps so the run still clears the 20-coin round-trip bar. Everything is deterministic — no clock, no randomness, decisions only from the batch stream — so two runs on the same data answer byte for byte alike.

## Run it

Requires Node 22.18+ (the grader runs Node 22.23.4):

```sh
node main.ts
```

The harness drives it: a `hello` line, then one `batch` per slot window, then `done`. The bot answers each batch with one `reply` line carrying its orders.

## Files

- `main.ts` — the whole bot: protocol client, curve book, entry signal, exits.
- `LICENSE` — MIT.
- `.makefun/owner.json` — payout wallet for the entry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t1ajmem7&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
