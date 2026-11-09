
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const BASE = "https://apiv2.nobitex.ir";
const STATE_FILE = path.join(__dirname, "paper-state.json");

const CONFIG = {
  initialCapital: 10_000_000,
  riskPercent: 0.5,
  stopPercent: 0.5,
  rewardRatio: 2,
  feePercent: 0.1,
  slippagePercent: 0.05,
  dailyLossLimit: 2,
  dailyProfitTarget: 1,
  maxDailyTrades: 8,
  maxOpenTrades: 2,
  scanDelay: 2200
};

function newState() {
  return {
    running: false,
    capital: CONFIG.initialCapital,
    history: [],
    positions: {},
    tradesToday: 0,
    day: new Date().toISOString().slice(0, 10),
    dailyPnl: 0,
    markets: [],
    lastScan: null,
    lastError: null
  };
}

let state = newState();
let scanIndex = 0;
let busy = false;
let lastStatsUpdate = 0;

try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state = { ...newState(), ...saved };
  }
} catch {
  state = newState();
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("Save error:", error.message);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function resetDayIfNeeded() {
  if (state.day !== today()) {
    state.day = today();
    state.tradesToday = 0;
    state.dailyPnl = 0;
    save();
  }
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function api(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "TraderBot/MAHORA-AI-1.0"
    },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error("Nobitex HTTP " + response.status);
  }

  return response.json();
}

// دریافت فهرست بازارهای فعال ریالی
async function updateMarkets() {
  const data = await api(BASE + "/market/stats");

  if (data.status !== "ok" || !data.stats) {
    throw new Error("Invalid market statistics");
  }

  const markets = [];

  for (const [pair, item] of Object.entries(data.stats)) {
    if (!pair.endsWith("-rls")) continue;
    if (item.isClosed) continue;
    if (number(item.latest) <= 0) continue;

    const baseCurrency = pair.split("-")[0];
    const symbol = baseCurrency.toUpperCase() + "IRT";

    markets.push({
      pair,
      symbol,
      price: number(item.latest) / 10,
      volume: number(item.volumeDst),
      change: number(item.dayChange)
    });
  }

  state.markets = markets;
  lastStatsUpdate = Date.now();
  save();
}

// دریافت کندل‌های یک بازار
async function getCandles(symbol, resolution) {
  const to = Math.floor(Date.now() / 1000);

  const url = new URL(BASE + "/market/udf/history");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", resolution);
  url.searchParams.set("to", String(to));
  url.searchParams.set("countback", "100");

  const data = await api(url.toString());

  if (data.s !== "ok" || !Array.isArray(data.c)) {
    return [];
  }

  // قیمت API ریال است؛ تبدیل به تومان
  return data.c.map(value => number(value) / 10);
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function signal(values) {
  if (values.length < 30) return "WAIT";

  const previous = values.slice(0, -1);

  const fastNow = ema(values, 9);
  const slowNow = ema(values, 21);
  const fastBefore = ema(previous, 9);
  const slowBefore = ema(previous, 21);
  const momentum = rsi(values);

  if (
    fastBefore <= slowBefore &&
    fastNow > slowNow &&
    momentum > 45 &&
    momentum < 70
  ) return "BUY";

  if (
    fastBefore >= slowBefore &&
    fastNow < slowNow &&
    momentum < 55 &&
    momentum > 30
  ) return "SELL";

  return "WAIT";
}

function canOpenTrade() {
  resetDayIfNeeded();

  const dailyLimit = CONFIG.initialCapital *
    CONFIG.dailyLossLimit / 100;

  const dailyTarget = CONFIG.initialCapital *
    CONFIG.dailyProfitTarget / 100;

  if (state.dailyPnl <= -dailyLimit) return false;
  if (state.dailyPnl >= dailyTarget) return false;
  if (state.tradesToday >= CONFIG.maxDailyTrades) return false;

  if (Object.keys(state.positions).length >= CONFIG.maxOpenTrades) {
    return false;
  }

  return true;
}

function openTrade(engine, symbol, side, price) {
  if (state.positions[engine]) return;
  if (!canOpenTrade()) return;

  const multiplier = engine === "day" ? 1.5 : 1;
  const stopDistance = CONFIG.stopPercent / 100 * multiplier;

  const riskMoney =
    state.capital * CONFIG.riskPercent / 100;

  const quantity = riskMoney / (price * stopDistance);

  if (!Number.isFinite(quantity) || quantity <= 0) return;

  const slippage = CONFIG.slippagePercent / 100;

  const entryPrice = side === "BUY"
    ? price * (1 + slippage)
    : price * (1 - slippage);

  const stopLoss = side === "BUY"
    ? entryPrice * (1 - stopDistance)
    : entryPrice * (1 + stopDistance);

  const takeProfit = side === "BUY"
    ? entryPrice * (1 + stopDistance * CONFIG.rewardRatio)
    : entryPrice * (1 - stopDistance * CONFIG.rewardRatio);

  const entryFee =
    entryPrice * quantity * CONFIG.feePercent / 100;

  state.positions[engine] = {
    engine,
    symbol,
    side,
    entryPrice,
    quantity,
    stopLoss,
    takeProfit,
    entryFee,
    openedAt: Date.now()
  };

  state.tradesToday++;
  save();

  console.log("PAPER OPEN:", engine, symbol, side);
}

function closeTrade(engine, price, reason) {
  const position = state.positions[engine];
  if (!position) return;

  const slippage = CONFIG.slippagePercent / 100;

  const exitPrice = position.side === "BUY"
    ? price * (1 - slippage)
    : price * (1 + slippage);

  const direction = position.side === "BUY" ? 1 : -1;

  const grossPnl =
    (exitPrice - position.entryPrice) *
    position.quantity * direction;

  const exitFee =
    exitPrice * position.quantity *
    CONFIG.feePercent / 100;

  const netPnl =
    grossPnl - position.entryFee - exitFee;

  state.capital += netPnl;
  state.dailyPnl += netPnl;

  state.history.unshift({
    engine,
    symbol: position.symbol,
    side: position.side,
    entry: position.entryPrice,
    exit: exitPrice,
    pnl: netPnl,
    reason,
    time: Date.now()
  });

  state.history = state.history.slice(0, 500);
  delete state.positions[engine];

  save();

  console.log("PAPER CLOSE:", engine, netPnl, reason);
}

function manageTrade(engine, price) {
  const p = state.positions[engine];
  if (!p) return;

  if (p.side === "BUY") {
    if (price <= p.stopLoss) {
      closeTrade(engine, price, "STOP_LOSS");
    } else if (price >= p.takeProfit) {
      closeTrade(engine, price, "TAKE_PROFIT");
    }
  } else {
    if (price >= p.stopLoss) {
      closeTrade(engine, price, "STOP_LOSS");
    } else if (price <= p.takeProfit) {
      closeTrade(engine, price, "TAKE_PROFIT");
    }
  }
}

async function scanMarket(market) {
  const [oneMinute, fifteenMinute] = await Promise.all([
    getCandles(market.symbol, "1"),
    getCandles(market.symbol, "15")
  ]);

  if (oneMinute.length < 30 || fifteenMinute.length < 30) {
    return;
  }

  const currentPrice = oneMinute[oneMinute.length - 1];

  // مدیریت معاملات باز
  for (const engine of ["scalping", "day"]) {
    const position = state.positions[engine];

    if (position && position.symbol === market.symbol) {
      manageTrade(engine, currentPrice);
    }
  }

  if (!state.running || !canOpenTrade()) return;

  // موتور اسکالپ
  if (!state.positions.scalping) {
    const s = signal(oneMinute);

    if (s !== "WAIT") {
      openTrade("scalping", market.symbol, s, currentPrice);
    }
  }

  // موتور معاملات روزانه
  if (!state.positions.day && canOpenTrade()) {
    const s = signal(fifteenMinute);

    if (s !== "WAIT") {
      openTrade("day", market.symbol, s, currentPrice);
    }
  }
}

async function mainLoop() {
  if (busy || !state.running) return;

  busy = true;

  try {
    resetDayIfNeeded();

    if (
      !state.markets.length ||
      Date.now() - lastStatsUpdate > 60_000
    ) {
      await updateMarkets();
    }

    if (!state.markets.length) {
      throw new Error("No active Rial markets found");
    }

    if (scanIndex >= state.markets.length) {
      scanIndex = 0;
    }

    const market = state.markets[scanIndex];
    scanIndex++;

    await scanMarket(market);

    state.lastScan = {
      symbol: market.symbol,
      time: Date.now(),
      progress: scanIndex + "/" + state.markets.length
    };

    state.lastError = null;
    save();

  } catch (error) {
    state.lastError = error.message;
    console.error("SCAN ERROR:", error.message);
  } finally {
    busy = false;
  }
}

// API کنترل و مشاهده وضعیت موتور
function send(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });

  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 200, { status: "ok" });
  }

  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/status") {
    return send(res, 200, {
      name: "MAHORA AI",
      mode: "PAPER_TRADING",
      running: state.running,
      capital: state.capital,
      totalPnl: state.capital - CONFIG.initialCapital,
      dailyPnl: state.dailyPnl,
      tradesToday: state.tradesToday,
      openPositions: Object.values(state.positions),
      history: state.history.slice(0, 30),
      marketCount: state.markets.length,
      lastScan: state.lastScan,
      lastError: state.lastError,
      config: CONFIG
    });
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    state.running = true;
    save();
    return send(res, 200, { status: "started" });
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    state.running = false;
    save();
    return send(res, 200, { status: "stopped" });
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (state.running) {
      return send(res, 409, {
        error: "ابتدا موتور را خاموش کنید."
      });
    }

    state = newState();
    scanIndex = 0;
    lastStatsUpdate = 0;
    save();

    return send(res, 200, { status: "reset" });
  }

  return send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log("MAHORA AI engine listening on port", PORT);
  console.log("Paper Trading only - no real orders");
});

setInterval(mainLoop, CONFIG.scanDelay);
