// Sprinter: a young-momentum paper trader for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Idea, in one paragraph: most pump.fun coins die within minutes, a few run hard
// within their first hour. So this bot only buys coins that are minutes old and
// already show real buying: the price is up from its launch price, fresh SOL is
// flowing in from several different wallets, and the price is sitting near its
// young high. It risks a fixed stake per coin, then gets out fast: a hard stop
// below cost, a take-profit above it, a trailing stop once a winner is armed, a
// time limit, and an exit when the tape turns into heavy selling or one big
// seller dumps. One buy per coin, ever. Nothing here uses the clock, randomness,
// the network, or any file: every decision comes from the batch stream, so two
// runs on the same data answer byte for byte alike.
//
// Money rules: the replay hands us 10 SOL, at most 5 open positions, and no buy
// may exceed 1% of a curve's real SOL reserve. We stake 0.2 SOL per coin when
// the cap allows it and never less than 0.02 SOL, so every round trip clears the
// 0.01 SOL minimum with room to spare. Fees are read from the hello message
// (base + priority per order) and always reserved before a buy is sent.

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS_DENOM = 10_000n;

// ---- tunables (all in SOL or slots unless noted; 1 slot is ~0.4 s) ----
const STAKE_LAMPORTS = 200_000_000n; // 0.2 SOL per coin at most
const MIN_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL: smallest buy worth sending
const WINDOW_SLOTS = 240; // tape lookback, ~96 s
const MIN_AGE_SLOTS = 30; // ignore the very first seconds (bundle dumps)
const MAX_ENTRY_AGE_SLOTS = 7_200; // stop chasing a coin after ~48 min
const MIN_PRICE_UP = 0.12; // price must be up >= 12% from launch
const MAX_PRICE_UP = 1.5; // ... but not already up > 150% in the window
const MIN_NET_IN_SOL = 0.5; // net SOL inflow (buys minus sells) in the window
const MIN_BUYS = 4; // buy trades in the window
const MIN_BUYERS = 3; // distinct buying wallets in the window
const NEAR_HIGH = 0.97; // price must sit within 3% of its young high
const MAX_TOP_BUYER_SHARE = 0.6; // no single wallet may dominate the inflow
const TAKE_PROFIT = 2.5; // sell everything at +150% on cost
const STOP_LOSS = 0.85; // sell everything at -15% on cost
const TRAIL_ARM = 1.5; // trailing stop arms at +50%
const TRAIL_GIVEBACK = 0.85; // ... and fires after a 15% pullback from the peak
const MAX_HOLD_SLOTS = 10_800; // sell after ~72 min held, whatever the price
const FADE_NET_SOL = -1.0; // sell when the window's net flow turns this negative
const BIG_SELL_SOL = 1.5; // sell when one recorded sell is at least this big
const MAX_SLIPPAGE_BPS = 10_000; // fills must land; never let slippage strand us

// Relaxed entry tiers, so a quiet stretch of the window can never leave us
// short of the 20-coin round-trip bar. The tiers only loosen the entry filter;
// exits never change.
const RELAX_AFTER_SLOTS = 10_000; // ~67 min in, if fewer than 5 coins bought...
const RELAX_BELOW_BUYS = 5;
const RELAX_PRICE_UP = 0.03;
const RELAX_NET_IN_SOL = 0.15;
const RELAX_MIN_BUY_TRADES = 3;
const RELAX_MIN_BUYERS = 2;
const RELAX2_AFTER_SLOTS = 30_000; // ~3.3 h in, if fewer than 10 coins bought...
const RELAX2_BELOW_BUYS = 10;
const RELAX2_PRICE_UP = 0.0;
const RELAX2_NET_IN_SOL = 0.1;
const RELAX2_MIN_BUY_TRADES = 2;
const RELAX2_MIN_BUYERS = 1;

// ---- wire shapes (minimal subset of agent-fun/replay/v2) ----

interface HelloMsg {
  type: "hello";
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
  };
  latency_slots: number;
  fees: { base_fee_lamports: string; priority_fee_lamports: string };
}

interface TradeEv {
  event: "TradeEvent";
  mint: string;
  sol_amount: string;
  is_buy: boolean;
  user: string;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  real_sol_reserves: string;
  slot: number;
}

interface CreateEv {
  event: "CreateEvent";
  mint: string;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  slot: number;
}

interface CompleteEv {
  event: "CompleteEvent";
  mint: string;
  slot: number;
}

type ChainEv = TradeEv | CreateEv | CompleteEv;

interface MarkMsg {
  mint: string;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

interface FillMsg {
  client_id: string;
  mint: string;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
}

interface AccountMsg {
  cash_lamports: string;
  positions: { mint: string; token_amount: string; cost_lamports: string }[];
}

interface BatchMsg {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEv[];
  marks: MarkMsg[];
  fills: FillMsg[];
  account: AccountMsg;
}

type InMsg = HelloMsg | BatchMsg | { type: "done"; seq: number };

interface WireOrder {
  side: "buy" | "sell";
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ---- per-curve bookkeeping ----

interface TapeTrade {
  slot: number;
  signedSol: number; // +buy SOL, -sell SOL
  buyerSol: number; // buy SOL only, for the top-buyer share
  user: string;
}

interface Curve {
  mint: string;
  createdSlot: number;
  firstPrice: number; // SOL per token at launch (0 = unknown yet)
  lastPrice: number;
  highPrice: number;
  realQuote: bigint; // real SOL reserves, latest seen
  complete: boolean;
  tape: TapeTrade[];
}

interface HeldCoin {
  mint: string;
  entrySlot: number;
  peakValueLamports: bigint; // best marked value since entry, for the trail
}

const curves = new Map<string, Curve>();
const bought = new Set<string>(); // mints we ever bought (one entry each)
const decided = new Set<string>(); // mints we stopped considering for entry
const held = new Map<string, HeldCoin>(); // currently held, by mint
const pending = new Map<string, { side: "buy" | "sell"; mint: string }>();
const pendingBuyMints = new Set<string>();
const pendingSellMints = new Set<string>();

let hello: HelloMsg | null = null;
let cash = 0n;
let orderCounter = 0;
let firstSlot = -1;
let boughtCount = 0;

function priceOf(vQuote: string, vToken: string): number {
  const q = Number(vQuote);
  const t = Number(vToken);
  if (q <= 0 || t <= 0) return 0;
  return q / t;
}

function curveFor(mint: string, slot: number): Curve {
  let c = curves.get(mint);
  if (c === undefined) {
    c = {
      mint,
      createdSlot: slot,
      firstPrice: 0,
      lastPrice: 0,
      highPrice: 0,
      realQuote: 0n,
      complete: false,
      tape: [],
    };
    curves.set(mint, c);
  }
  return c;
}

function notePrice(c: Curve, price: number): void {
  if (price <= 0) return;
  if (c.firstPrice === 0) c.firstPrice = price;
  c.lastPrice = price;
  if (price > c.highPrice) c.highPrice = price;
}

function pruneTape(c: Curve, nowSlot: number): void {
  const cutoff = nowSlot - WINDOW_SLOTS;
  let drop = 0;
  while (drop < c.tape.length && c.tape[drop].slot < cutoff) drop++;
  if (drop > 0) c.tape.splice(0, drop);
}

function txFee(): bigint {
  if (hello === null) return 0n;
  return BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
}

/** Largest buy this batch may spend on this mint: 1% of its real SOL reserve. */
function buyCapLamports(c: Curve): bigint {
  if (c.complete || hello === null) return 0n;
  return (
    (c.realQuote * BigInt(hello.caps.max_order_bps_of_real_reserve)) / BPS_DENOM
  );
}

// Pending buy amounts are remembered alongside their client id so free cash
// stays exact while orders are in flight.
const pendingBuyAmounts = new Map<string, bigint>();

function spendableCash(): bigint {
  let free = cash;
  const fee = txFee();
  for (const [id, p] of pending.entries()) {
    free -= fee;
    if (p.side === "buy") free -= pendingBuyAmounts.get(id) ?? 0n;
  }
  return free;
}

function openSlots(): number {
  if (hello === null) return 0;
  const mints = new Set<string>(held.keys());
  for (const m of pendingBuyMints) mints.add(m);
  return hello.caps.max_open_positions - mints.size;
}

function entryThresholds(nowSlot: number): {
  minUp: number;
  minNet: number;
  minBuys: number;
  minBuyers: number;
} {
  const elapsed = firstSlot < 0 ? 0 : nowSlot - firstSlot;
  if (elapsed >= RELAX2_AFTER_SLOTS && boughtCount < RELAX2_BELOW_BUYS) {
    return {
      minUp: RELAX2_PRICE_UP,
      minNet: RELAX2_NET_IN_SOL,
      minBuys: RELAX2_MIN_BUY_TRADES,
      minBuyers: RELAX2_MIN_BUYERS,
    };
  }
  if (elapsed >= RELAX_AFTER_SLOTS && boughtCount < RELAX_BELOW_BUYS) {
    return {
      minUp: RELAX_PRICE_UP,
      minNet: RELAX_NET_IN_SOL,
      minBuys: RELAX_MIN_BUY_TRADES,
      minBuyers: RELAX_MIN_BUYERS,
    };
  }
  return {
    minUp: MIN_PRICE_UP,
    minNet: MIN_NET_IN_SOL,
    minBuys: MIN_BUYS,
    minBuyers: MIN_BUYERS,
  };
}

/** True when the curve's tape shows genuine fresh buying, not one big wallet. */
function entrySignal(c: Curve, nowSlot: number): boolean {
  if (c.complete || c.firstPrice <= 0 || c.lastPrice <= 0) return false;
  const age = nowSlot - c.createdSlot;
  if (age < MIN_AGE_SLOTS || age > MAX_ENTRY_AGE_SLOTS) return false;
  const t = entryThresholds(nowSlot);
  const up = c.lastPrice / c.firstPrice - 1;
  if (up < t.minUp || up > MAX_PRICE_UP) return false;
  if (c.lastPrice < NEAR_HIGH * c.highPrice) return false;
  pruneTape(c, nowSlot);
  let net = 0;
  let buys = 0;
  let buySol = 0;
  const buyers = new Set<string>();
  const buyerTotals = new Map<string, number>();
  for (const tr of c.tape) {
    net += tr.signedSol;
    if (tr.signedSol > 0) {
      buys++;
      buySol += tr.signedSol;
      buyers.add(tr.user);
      buyerTotals.set(tr.user, (buyerTotals.get(tr.user) ?? 0) + tr.signedSol);
    }
  }
  if (net < t.minNet || buys < t.minBuys || buyers.size < t.minBuyers) return false;
  let top = 0;
  for (const v of buyerTotals.values()) if (v > top) top = v;
  if (buySol > 0 && top / buySol > MAX_TOP_BUYER_SHARE) return false;
  return true;
}

function nextClientId(): string {
  orderCounter++;
  return `o${orderCounter}`;
}

function decide(batch: BatchMsg): WireOrder[] {
  const orders: WireOrder[] = [];
  if (hello === null) return orders;
  const nowSlot = batch.slot;
  if (firstSlot < 0) firstSlot = nowSlot;

  // 1. Fold the batch in: fills clear pending orders, marks refresh reserves,
  //    events extend tapes and register new curves.
  for (const f of batch.fills) {
    const p = pending.get(f.client_id);
    if (p !== undefined) {
      pending.delete(f.client_id);
      pendingBuyAmounts.delete(f.client_id);
      if (p.side === "buy") pendingBuyMints.delete(p.mint);
      else pendingSellMints.delete(p.mint);
    }
  }
  cash = BigInt(batch.account.cash_lamports);
  for (const m of batch.marks) {
    const c = curves.get(m.mint);
    if (c === undefined) continue;
    c.realQuote = BigInt(m.real_quote_reserves);
    notePrice(c, priceOf(m.virtual_quote_reserves, m.virtual_token_reserves));
  }
  // Live positions from the account are the truth; drop held coins that are gone.
  const liveMints = new Set<string>();
  for (const pos of batch.account.positions) liveMints.add(pos.mint);
  for (const mint of [...held.keys()]) {
    if (!liveMints.has(mint)) held.delete(mint);
  }

  let bigSellMints = new Set<string>();
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const c = curveFor(e.mint, e.slot);
      c.createdSlot = e.slot;
      c.realQuote = 0n;
      notePrice(c, priceOf(e.virtual_sol_reserves, e.virtual_token_reserves));
    } else if (e.event === "TradeEvent") {
      const c = curveFor(e.mint, e.slot);
      c.realQuote = BigInt(e.real_sol_reserves);
      notePrice(c, priceOf(e.virtual_sol_reserves, e.virtual_token_reserves));
      const sol = Number(e.sol_amount) / 1e9;
      c.tape.push({
        slot: e.slot,
        signedSol: e.is_buy ? sol : -sol,
        buyerSol: e.is_buy ? sol : 0,
        user: e.user,
      });
      if (!e.is_buy && sol >= BIG_SELL_SOL) bigSellMints.add(e.mint);
    } else {
      const c = curveFor(e.mint, e.slot);
      c.complete = true;
    }
  }

  // 2. Exits first: a coin that must go frees its slot for a new entry.
  const marks = new Map<string, number>();
  for (const m of batch.marks) {
    marks.set(m.mint, priceOf(m.virtual_quote_reserves, m.virtual_token_reserves));
  }
  for (const pos of batch.account.positions) {
    const mint = pos.mint;
    if (pendingSellMints.has(mint)) continue;
    const price = marks.get(mint) ?? curves.get(mint)?.lastPrice ?? 0;
    if (price <= 0) continue;
    const tokens = BigInt(pos.token_amount);
    const cost = BigInt(pos.cost_lamports);
    if (cost <= 0n || tokens <= 0n) continue;
    // Marked value, in lamports: tokens * (SOL per token) * 1e9.
    const value = BigInt(Math.floor(Number(tokens) * price * 1e9));
    let rec = held.get(mint);
    if (rec === undefined) {
      rec = { mint, entrySlot: nowSlot, peakValueLamports: value };
      held.set(mint, rec);
    }
    if (value > rec.peakValueLamports) rec.peakValueLamports = value;

    let sell = false;
    if (value >= (cost * 25n) / 10n) sell = true; // take profit +150%
    else if (value <= (cost * 85n) / 100n) sell = true; // stop loss -15%
    else if (
      value >= (cost * 15n) / 10n &&
      value <= (rec.peakValueLamports * 85n) / 100n
    ) {
      sell = true; // trailing stop, armed at +50%, fires on a 15% pullback
    } else if (nowSlot - rec.entrySlot > MAX_HOLD_SLOTS) sell = true;
    else if (bigSellMints.has(mint)) sell = true;
    else {
      const c = curves.get(mint);
      if (c !== undefined) {
        pruneTape(c, nowSlot);
        let net = 0;
        for (const tr of c.tape) net += tr.signedSol;
        if (net < FADE_NET_SOL) sell = true;
      }
    }
    if (sell && orders.length < hello.caps.max_orders_per_batch) {
      const id = nextClientId();
      orders.push({
        side: "sell",
        client_id: id,
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pending.set(id, { side: "sell", mint });
      pendingSellMints.add(mint);
    }
  }

  // 3. Entries: walk the batch's events in order; a coin is considered once
  //    its tape shows the signal and its size cap can carry a real buy.
  let free = spendableCash();
  const fee = txFee();
  let slots = openSlots();
  for (const e of batch.events) {
    if (orders.length >= hello.caps.max_orders_per_batch) break;
    if (slots <= 0) break;
    const mint = e.mint;
    if (bought.has(mint) || decided.has(mint)) continue;
    if (pendingBuyMints.has(mint) || held.has(mint)) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete) {
      if (c?.complete) decided.add(mint);
      continue;
    }
    if (nowSlot - c.createdSlot > MAX_ENTRY_AGE_SLOTS) {
      decided.add(mint);
      continue;
    }
    if (!entrySignal(c, nowSlot)) continue;
    const cap = buyCapLamports(c);
    if (cap < MIN_BUY_LAMPORTS) continue; // too small to matter; keep waiting
    const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
    if (free < amount + fee) continue; // cannot afford it; keep waiting
    const id = nextClientId();
    orders.push({
      side: "buy",
      client_id: id,
      mint,
      quote_lamports: amount.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    pending.set(id, { side: "buy", mint });
    pendingBuyAmounts.set(id, amount);
    pendingBuyMints.add(mint);
    bought.add(mint);
    boughtCount++;
    free -= amount + fee;
    slots -= 1;
  }

  return orders;
}

async function main(): Promise<void> {
  let buf = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buf += chunk;
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (line.length === 0) continue;
      const msg = JSON.parse(line) as InMsg;
      if (msg.type === "hello") {
        hello = msg as HelloMsg;
        cash = BigInt(hello.capital.lamports);
      } else if (msg.type === "batch") {
        const batch = msg as BatchMsg;
        const orders = decide(batch);
        process.stdout.write(
          JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n",
        );
      } else if (msg.type === "done") {
        return;
      }
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`sprinter: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
