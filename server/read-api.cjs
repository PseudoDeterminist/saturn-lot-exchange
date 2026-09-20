#!/usr/bin/env node
"use strict";

const http = require("http");

// This service intentionally supports exactly one ETC market. Do not turn this
// into a generic JSON-RPC proxy or accept addresses/calldata from callers.
const BIND_HOST = "127.0.0.1";
const PORT = Number(process.env.READ_API_PORT || 8787);
const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = 61n;
const CONTRACT_ADDRESS = "0x989445dA165F787Bb07B9C04946D87BbF9051EEf";
const WETC_ADDRESS = "0x82A618305706B14e7bcf2592D4B9324A366b6dAd";
const STRN10K_ADDRESS = "0x7d35D3938c3b4446473a4ac29351Bd93694b5DEF";
const MIN_TICK = -464;
const MAX_TICK = 1855;
const DEFAULT_DEPTH = 25;
const MAX_DEPTH = 200;
const DEFAULT_ORDERS = 50;
const MAX_ORDERS = 200;

// Keccak selectors for the fixed view ABI. Keeping these local makes the
// service dependency-free and prevents caller-controlled calldata.
const SELECTOR = {
  getBuyBook: "3877efe8",
  getSellBook: "f9a0873c",
  getBuyOrders: "aecdb7f3",
  getSellOrders: "338faaa6",
  getOracle: "833b1fce",
  getEscrowTotals: "f758bbe6",
  priceAtTick: "ed27e27d"
};
const UINT_256 = 1n << 256n;
const INT_255 = 1n << 255n;
let rpcId = 0;

function decimal(value) {
  return BigInt(value).toString();
}

function encodeWord(value, signed = false) {
  let number = BigInt(value);
  if (signed && number < 0n) number += UINT_256;
  if (number < 0n || number >= UINT_256) throw new Error("ABI integer out of range");
  return number.toString(16).padStart(64, "0");
}

function words(result) {
  if (typeof result !== "string" || !/^0x(?:[0-9a-fA-F]{64})*$/.test(result)) {
    throw new Error("invalid eth_call response");
  }
  return result.slice(2).match(/.{64}/g) || [];
}

function uintAt(result, index) {
  if (index < 0 || index >= result.length) throw new Error("truncated eth_call response");
  return BigInt(`0x${result[index]}`);
}

function intAt(result, index) {
  const value = uintAt(result, index);
  return value >= INT_255 ? value - UINT_256 : value;
}

function offsetAt(result, index) {
  const offset = uintAt(result, index);
  if (offset % 32n !== 0n || offset / 32n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("invalid ABI offset");
  }
  return Number(offset / 32n);
}

function decodeStaticArray(result, offset, fields, decodeItem) {
  const length = uintAt(result, offset);
  if (length > BigInt(MAX_ORDERS)) throw new Error("unexpected ABI array length");
  const count = Number(length);
  if (offset + 1 + count * fields > result.length) throw new Error("truncated ABI array");
  return Array.from({ length: count }, (_, i) => decodeItem(result, offset + 1 + i * fields));
}

function decodeBook(resultHex) {
  const result = words(resultHex);
  return {
    out: decodeStaticArray(result, offsetAt(result, 0), 5, (data, index) => ({
      tick: intAt(data, index), price: uintAt(data, index + 1), totalLots: uintAt(data, index + 2),
      totalValue: uintAt(data, index + 3), orderCount: uintAt(data, index + 4)
    })),
    n: uintAt(result, 1)
  };
}

function decodeOrders(resultHex) {
  const result = words(resultHex);
  return {
    out: decodeStaticArray(result, offsetAt(result, 0), 6, (data, index) => ({
      id: uintAt(data, index),
      owner: `0x${data[index + 1].slice(24)}`,
      tick: intAt(data, index + 2), price: uintAt(data, index + 3),
      lotsRemaining: uintAt(data, index + 4), valueRemaining: uintAt(data, index + 5)
    })),
    n: uintAt(result, 1)
  };
}

function decodeOracle(resultHex) {
  const result = words(resultHex);
  return {
    bestBuyTick: intAt(result, 0), bestSellTick: intAt(result, 1), lastTradeTick: intAt(result, 2),
    lastTradeBlock: uintAt(result, 3), lastTradePrice: uintAt(result, 4)
  };
}

function decodeEscrow(resultHex) {
  const result = words(resultHex);
  return { buyWETC: uintAt(result, 0), sellSTRN10K: uintAt(result, 1) };
}

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "RPC error");
  return body.result;
}

async function call(selector, argument, signed = false) {
  const data = `0x${selector}${argument === undefined ? "" : encodeWord(argument, signed)}`;
  return rpc("eth_call", [{ to: CONTRACT_ADDRESS, data }, "latest"]);
}

function levelDto(level) {
  return {
    tick: decimal(level.tick),
    price: decimal(level.price),
    totalLots: decimal(level.totalLots),
    totalValue: decimal(level.totalValue),
    orderCount: decimal(level.orderCount)
  };
}

function orderDto(order) {
  return {
    id: decimal(order.id),
    owner: order.owner,
    tick: decimal(order.tick),
    price: decimal(order.price),
    lotsRemaining: decimal(order.lotsRemaining),
    valueRemaining: decimal(order.valueRemaining)
  };
}

function parseBoundedPositive(searchParams, name, fallback, maximum) {
  const values = searchParams.getAll(name);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0])) {
    throw new Error(`invalid ${name}`);
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function parseTick(searchParams) {
  const values = searchParams.getAll("tick");
  if (values.length !== 1 || !/^-?(0|[1-9][0-9]*)$/.test(values[0])) {
    throw new Error("invalid tick");
  }
  const tick = Number(values[0]);
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick must be between ${MIN_TICK} and ${MAX_TICK}`);
  }
  return tick;
}

async function requireEtcNetwork() {
  const chainId = BigInt(await rpc("eth_chainId", []));
  if (chainId !== CHAIN_ID) {
    throw new Error(`unexpected chain ID ${chainId.toString()}`);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

function marketMetadata() {
  return {
    chainId: CHAIN_ID.toString(),
    contractAddress: CONTRACT_ADDRESS,
    wetcAddress: WETC_ADDRESS,
    strn10kAddress: STRN10K_ADDRESS
  };
}

async function handle(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname === "/api/health") {
      await requireEtcNetwork();
      sendJson(res, 200, { ok: true, rpc: "connected", ...marketMetadata() });
      return;
    }

    if (url.pathname === "/api/market") {
      const depth = parseBoundedPositive(url.searchParams, "depth", DEFAULT_DEPTH, MAX_DEPTH);
      const orders = parseBoundedPositive(url.searchParams, "orders", DEFAULT_ORDERS, MAX_ORDERS);
      await requireEtcNetwork();
      const [buyBook, sellBook, oracle, escrow, buyOrders, sellOrders] = await Promise.all([
        call(SELECTOR.getBuyBook, depth).then(decodeBook),
        call(SELECTOR.getSellBook, depth).then(decodeBook),
        call(SELECTOR.getOracle).then(decodeOracle),
        call(SELECTOR.getEscrowTotals).then(decodeEscrow),
        call(SELECTOR.getBuyOrders, orders).then(decodeOrders),
        call(SELECTOR.getSellOrders, orders).then(decodeOrders)
      ]);
      const buyCount = Number(buyBook.n);
      const sellCount = Number(sellBook.n);
      const buyOrderCount = Number(buyOrders.n);
      const sellOrderCount = Number(sellOrders.n);
      sendJson(res, 200, {
        ...marketMetadata(),
        depth,
        orders,
        buyBook: { levels: Array.from(buyBook.out).slice(0, buyCount).map(levelDto), count: decimal(buyBook.n) },
        sellBook: { levels: Array.from(sellBook.out).slice(0, sellCount).map(levelDto), count: decimal(sellBook.n) },
        buyOrders: { orders: Array.from(buyOrders.out).slice(0, buyOrderCount).map(orderDto), count: decimal(buyOrders.n) },
        sellOrders: { orders: Array.from(sellOrders.out).slice(0, sellOrderCount).map(orderDto), count: decimal(sellOrders.n) },
        oracle: {
          bestBuyTick: decimal(oracle.bestBuyTick),
          bestSellTick: decimal(oracle.bestSellTick),
          lastTradeTick: decimal(oracle.lastTradeTick),
          lastTradeBlock: decimal(oracle.lastTradeBlock),
          lastTradePrice: decimal(oracle.lastTradePrice)
        },
        escrow: { buyWETC: decimal(escrow.buyWETC), sellSTRN10K: decimal(escrow.sellSTRN10K) }
      });
      return;
    }

    if (url.pathname === "/api/price") {
      const tick = parseTick(url.searchParams);
      await requireEtcNetwork();
      const result = words(await call(SELECTOR.priceAtTick, tick, true));
      sendJson(res, 200, { ...marketMetadata(), tick: String(tick), price: decimal(uintAt(result, 0)) });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    if (err.message && (err.message.startsWith("invalid ") || err.message.includes("must be between"))) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    console.error("read API request failed:", err);
    sendJson(res, 503, { error: "ETC read service unavailable" });
  }
}

const server = http.createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`Saturn read API listening on http://${BIND_HOST}:${PORT}`);
});
