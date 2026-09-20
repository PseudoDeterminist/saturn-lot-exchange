#!/usr/bin/env node
"use strict";

const API_URL = process.env.READ_API_URL || "http://127.0.0.1:8787";

async function request(path, expectedStatus = 200) {
  const response = await fetch(`${API_URL}${path}`);
  const body = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function assertDecimal(value, field) {
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) {
    throw new Error(`${field} is not a decimal string`);
  }
}

(async () => {
  const health = await request("/api/health");
  if (health.ok !== true || health.chainId !== "61") throw new Error("health did not report ETC chain 61");

  const market = await request("/api/market?depth=1&orders=1");
  if (market.chainId !== "61") throw new Error("market did not report ETC chain 61");
  assertDecimal(market.buyBook.count, "buyBook.count");
  assertDecimal(market.sellBook.count, "sellBook.count");
  assertDecimal(market.oracle.lastTradeBlock, "oracle.lastTradeBlock");
  assertDecimal(market.escrow.buyWETC, "escrow.buyWETC");

  const price = await request("/api/price?tick=0");
  if (price.tick !== "0") throw new Error("price endpoint returned an unexpected tick");
  assertDecimal(price.price, "price.price");

  await request("/api/price?tick=1856", 400);
  await request("/api/market?depth=201", 400);
  console.log("Read API smoke test passed.");
})().catch((err) => {
  console.error("Read API smoke test failed:", err.message || err);
  process.exit(1);
});
