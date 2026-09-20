/* global ethers */
const config = window.APP_CONFIG || {};

const API_BASE = "/api";
const CONTRACT_ADDRESS = config.simpleLotTradeAddress || "";
const WETC_ADDRESS = config.wetcAddress || "";
const STRN10K_ADDRESS = config.strn10kAddress || "";
const MAX_LEVELS_DEFAULT = config.maxLevels || 25;
const MAX_ORDERS_DEFAULT = config.maxOrders || 50;
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";

const ABI = [
  "function getBuyBook(uint256) view returns (tuple(int256 tick,uint256 price,uint256 totalLots,uint256 totalValue,uint256 orderCount)[] out,uint256 n)",
  "function getSellBook(uint256) view returns (tuple(int256 tick,uint256 price,uint256 totalLots,uint256 totalValue,uint256 orderCount)[] out,uint256 n)",
  "function getBuyOrders(uint256) view returns (tuple(uint256 id,address owner,int256 tick,uint256 price,uint256 lotsRemaining,uint256 valueRemaining)[] out,uint256 n)",
  "function getSellOrders(uint256) view returns (tuple(uint256 id,address owner,int256 tick,uint256 price,uint256 lotsRemaining,uint256 valueRemaining)[] out,uint256 n)",
  "function getOracle() view returns (int256 bestBuyTick,int256 bestSellTick,int256 lastTradeTick,uint256 lastTradeBlock,uint256 lastTradePrice)",
  "function getTopOfBook() view returns (int256 bestBuyTick,uint256 buyLots,uint256 buyOrders,int256 bestSellTick,uint256 sellLots,uint256 sellOrders)",
  "function getEscrowTotals() view returns (uint256 buyWETC,uint256 sellSTRN10K)",
  "function historyHash() view returns (bytes32)",
  "function priceAtTick(int256 tick) view returns (uint256)",
  "function cancel(uint64 id)",
  "function placeBuy(int256 tick,uint256 lots) returns (uint64)",
  "function placeSell(int256 tick,uint256 lots) returns (uint64)",
  "function buyFOK(int256 limitTick,uint256 lots,uint256 maxWetcIn) returns (uint256)",
  "function buyFOK(int256 limitTick,uint256 lots,uint256 maxWetcIn,bytes32 expectedHash) returns (uint256)",
  "function sellFOK(int256 limitTick,uint256 lots,uint256 minWetcOut) returns (uint256)",
  "function sellFOK(int256 limitTick,uint256 lots,uint256 minWetcOut,bytes32 expectedHash) returns (uint256)"
];


const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const NONE = -(2n ** 31n);

const el = {
  statusPill: document.getElementById("status-pill"),
  chainStatus: document.getElementById("chain-status"),
  connectBtn: document.getElementById("connect-btn"),
  copyBtn: document.getElementById("copy-btn"),
  depthInput: document.getElementById("depth-input"),
  depthToggle: document.getElementById("depth-toggle"),
  refreshBtn: document.getElementById("refresh-btn"),
  seedBtn: document.getElementById("seed-btn"),
  clearBtn: document.getElementById("clear-btn"),
  buyBook: document.getElementById("buy-book"),
  sellBook: document.getElementById("sell-book"),
  spreadValue: document.getElementById("spread-value"),
  midTick: document.getElementById("mid-tick"),
  bestBid: document.getElementById("best-bid"),
  bestAsk: document.getElementById("best-ask"),
  emptyBanner: document.getElementById("empty-banner"),
  lastTradeStat: document.getElementById("last-trade-stat"),
  lastTrade: document.getElementById("last-trade"),
  escrowTotals: document.getElementById("escrow-totals"),
  midPrice: document.getElementById("mid-price"),
  lastBlock: document.getElementById("last-block"),
  liquidity: document.getElementById("liquidity"),
  sparkline: document.getElementById("sparkline"),
  openOrders: document.getElementById("open-orders"),
  recentTrades: document.getElementById("recent-trades"),
  lastUpdate: document.getElementById("last-update"),
  sideToggle: document.getElementById("side-toggle"),
  tickInput: document.getElementById("tick-input"),
  lotsInput: document.getElementById("lots-input"),
  previewPrice: document.getElementById("preview-price"),
  previewValue: document.getElementById("preview-value"),
  previewBtn: document.getElementById("preview-btn"),
  placeBtn: document.getElementById("place-btn"),
  addWetc: document.getElementById("add-wetc"),
  addStrn10k: document.getElementById("add-strn10k"),
  ticketStatus: document.getElementById("ticket-status"),
  takerLimitInput: document.getElementById("taker-limit-input"),
  takerValueInput: document.getElementById("taker-value-input"),
  takeBtn: document.getElementById("take-btn")
};

const state = {
  walletProvider: null,
  signer: null,
  walletAddress: null,
  walletReadContract: null,
  writeContract: null,
  wetc: null,
  strn10k: null,
  side: "buy",
  demoMode: false,
  lastTradeTick: null,
  lastTradeBlock: null,
  tape: [],
  readChainId: null
};

function toNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

async function fetchApi(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  let body;
  try {
    body = await response.json();
  } catch (_) {
    throw new Error("API returned an invalid response");
  }
  if (!response.ok) throw new Error(body.error || `API request failed (${response.status})`);
  return body;
}

async function getMarketSnapshot(depth, orders) {
  const params = new URLSearchParams({ depth: String(depth), orders: String(orders) });
  return fetchApi(`/market?${params}`);
}

async function getPriceAtTick(tick) {
  const result = await fetchApi(`/price?tick=${encodeURIComponent(String(tick))}`);
  return BigInt(result.price);
}

async function getLatestHistoryHash() {
  if (!state.writeContract) return null;
  try {
    // Keep transaction-concurrency reads on the wallet provider.
    return await state.writeContract.historyHash();
  } catch (err) {
    console.warn("historyHash lookup failed:", err);
    return null;
  }
}

async function takeOrder() {
  if (!state.writeContract || !state.signer) {
    setTicketStatus("Connect a wallet to take orders.");
    return;
  }

  const limit = Number(el.takerLimitInput.value);
  const lots = Number(el.lotsInput.value);
  const valueStr = (el.takerValueInput.value || "").trim();
  if (!Number.isFinite(limit) || !Number.isFinite(lots) || lots <= 0) {
    setTicketStatus("Enter a valid limit tick and lots.");
    return;
  }

  setTicketStatus("Preparing take...\n");

  try {
    const owner = await state.signer.getAddress();

    const expectedHash = await getLatestHistoryHash();

    if (state.side === "buy") {
      // taker buys: must approve WETC to contract
      if (!state.wetc) {
        setTicketStatus("WETC address missing.");
        return;
      }
      const wetc = state.wetc.connect(state.signer);
      const maxWetcIn = valueStr ? ethers.parseUnits(valueStr, 18) : 0n;
      const allowance = await wetc.allowance(owner, CONTRACT_ADDRESS);
      if (allowance < maxWetcIn) {
        setTicketStatus("Approving WETC...");
        const tx = await wetc.approve(CONTRACT_ADDRESS, ethers.MaxUint256);
        await tx.wait();
      }
      setTicketStatus("Submitting buyFOK...");
      // Use interface to disambiguate overloads and encode the exact call
      const iface = new ethers.Interface(ABI);
      let calldata;
      if (expectedHash) {
        calldata = iface.encodeFunctionData("buyFOK(int256,uint256,uint256,bytes32)", [limit, lots, maxWetcIn, expectedHash]);
      } else {
        calldata = iface.encodeFunctionData("buyFOK(int256,uint256,uint256)", [limit, lots, maxWetcIn]);
      }
      const tx = await state.signer.sendTransaction({
        to: CONTRACT_ADDRESS,
        data: calldata,
        gasLimit: 8000000
      });
      await tx.wait();
      setTicketStatus("buyFOK executed.");
    } else {
      // taker sells: must approve STRN10K to contract
      if (!state.strn10k) {
        setTicketStatus("STRN10K address missing.");
        return;
      }
      const strn = state.strn10k.connect(state.signer);
      const lotsBig = BigInt(lots);
      const allowance = await strn.allowance(owner, CONTRACT_ADDRESS);
      if (allowance < lotsBig) {
        setTicketStatus("Approving STRN10K...");
        const tx = await strn.approve(CONTRACT_ADDRESS, ethers.MaxUint256);
        await tx.wait();
      }
      const minWetcOut = valueStr ? ethers.parseUnits(valueStr, 18) : 0n;
      setTicketStatus("Submitting sellFOK...");
      // Use interface to disambiguate overloads and encode the exact call
      const iface = new ethers.Interface(ABI);
      let calldata;
      if (expectedHash) {
        calldata = iface.encodeFunctionData("sellFOK(int256,uint256,uint256,bytes32)", [limit, lots, minWetcOut, expectedHash]);
      } else {
        calldata = iface.encodeFunctionData("sellFOK(int256,uint256,uint256)", [limit, lots, minWetcOut]);
      }
      const tx = await state.signer.sendTransaction({
        to: CONTRACT_ADDRESS,
        data: calldata,
        gasLimit: 8000000
      });
      await tx.wait();
      setTicketStatus("sellFOK executed.");
    }

    await refresh();
  } catch (err) {
    setTicketStatus(`Take failed: ${err.message || err}`);
  }
}

function formatWetc(value, digits = 4) {
  if (value === null || value === undefined) return "--";
  const formatted = ethers.formatUnits(value, 18);
  const numeric = Number(formatted);
  if (!Number.isFinite(numeric)) return formatted;
  return numeric.toFixed(digits);
}

function formatInt(value) {
  const str = BigInt(value).toString();
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatLots(value) {
  if (value === null || value === undefined) return "--";
  return formatInt(value);
}

function formatTick(value) {
  if (value === null || value === undefined) return "--";
  return BigInt(value).toString();
}

function shortAddr(addr) {
  if (!addr) return "--";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function setStatus(text, ok) {
  el.statusPill.textContent = text;
  el.statusPill.style.color = ok ? "var(--buy)" : "var(--sell)";
  el.statusPill.style.borderColor = ok ? "rgba(74, 211, 155, 0.4)" : "rgba(255, 107, 107, 0.4)";
  el.statusPill.style.background = ok ? "rgba(74, 211, 155, 0.12)" : "rgba(255, 107, 107, 0.12)";
}

function setTicketStatus(text) {
  el.ticketStatus.textContent = text;
}

function pulse(elm) {
  if (!elm) return;
  elm.classList.remove("pulse");
  void elm.offsetWidth;
  elm.classList.add("pulse");
}

function updateDepthToggle(value) {
  if (!el.depthToggle) return;
  el.depthToggle.querySelectorAll(".chip").forEach((chip) => {
    const depth = Number(chip.dataset.depth);
    chip.classList.toggle("active", depth === value);
  });
}

function setDepth(value) {
  el.depthInput.value = String(value);
  updateDepthToggle(value);
  refresh();
}

function setDemoMode(reason) {
  if (!DEMO_MODE) {
    setStatus("RPC error", false);
    el.chainStatus.textContent = reason || "No RPC";
    return;
  }
  state.demoMode = true;
  setStatus("Demo mode", false);
  el.lastUpdate.textContent = "Demo data enabled";
  el.chainStatus.textContent = reason || "No RPC";
  el.emptyBanner.hidden = true;
  renderDemo();
}

function errorMessage(err) {
  if (!err) return "Unknown error";
  return err.shortMessage || err.message || String(err);
}

function renderDemo() {
  const buy = buildDemoBook("buy");
  const sell = buildDemoBook("sell");
  renderBook(el.buyBook, buy, "buy");
  renderBook(el.sellBook, sell, "sell");
  updateSpread(buy[0], sell[0]);
  renderOrders(buildDemoOrders(), buildDemoOrders(true));
  updateChart(buy, sell);
  el.lastUpdate.textContent = `Last update: demo`;
}

async function addTokenToWallet(address, fallbackSymbol, fallbackDecimals) {
  if (!window.ethereum) {
    setTicketStatus("No injected wallet found.");
    return;
  }
  if (!address) {
    setTicketStatus("Token address missing.");
    return;
  }
  let symbol = fallbackSymbol;
  let decimals = fallbackDecimals;
  try {
    const token =
      address.toLowerCase() === WETC_ADDRESS.toLowerCase()
        ? state.wetc
        : address.toLowerCase() === STRN10K_ADDRESS.toLowerCase()
          ? state.strn10k
          : state.walletProvider
            ? new ethers.Contract(address, ERC20_ABI, state.walletProvider)
            : null;
    if (token) {
      const [sym, dec] = await Promise.all([token.symbol(), token.decimals()]);
      symbol = sym || symbol;
      decimals = Number(dec);
    }
  } catch (err) {
    console.warn("Token metadata lookup failed:", err);
  }
  try {
    const added = await window.ethereum.request({
      method: "wallet_watchAsset",
      params: {
        type: "ERC20",
        options: {
          address,
          symbol,
          decimals
        }
      }
    });
    setTicketStatus(added ? `${symbol} added to MetaMask.` : "Token not added.");
  } catch (err) {
    setTicketStatus(`Add token failed: ${err.message || err}`);
  }
}

async function copyAddresses() {
  const lines = [
    `WETC=${WETC_ADDRESS || "-"}`,
    `STRN10K=${STRN10K_ADDRESS || "-"}`,
    `SaturnLotTrade=${CONTRACT_ADDRESS || "-"}`
  ];
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setTicketStatus("Addresses copied to clipboard.");
  } catch (err) {
    console.warn("Clipboard failed:", err);
    setTicketStatus("Copy failed. See console for addresses.");
    console.log(text);
  }
}

async function initProvider() {
  if (window.ethereum) {
    state.walletProvider = new ethers.BrowserProvider(window.ethereum);
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    setTicketStatus("No injected wallet found.");
    return;
  }
  try {
    if (!state.walletProvider) {
      await initProvider();
    }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    state.signer = await state.walletProvider.getSigner();
    state.walletReadContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, state.walletProvider);
    state.writeContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, state.signer);
    if (WETC_ADDRESS) state.wetc = new ethers.Contract(WETC_ADDRESS, ERC20_ABI, state.walletProvider);
    if (STRN10K_ADDRESS) state.strn10k = new ethers.Contract(STRN10K_ADDRESS, ERC20_ABI, state.walletProvider);
    state.walletAddress = (await state.signer.getAddress()).toLowerCase();
    el.connectBtn.textContent = shortAddr(state.walletAddress);
    el.placeBtn.disabled = false;
    el.clearBtn.disabled = false;
    el.seedBtn.disabled = false;
    setTicketStatus("Wallet connected. Ready to place orders.");
  } catch (err) {
    setTicketStatus(`Wallet error: ${err.message || err}`);
  }
}

function updateSpread(bestBid, bestAsk) {
  if (!bestBid || !bestAsk) {
    el.spreadValue.textContent = "--";
    el.midTick.textContent = "--";
    return;
  }
  const bidPrice = BigInt(bestBid.price);
  const askPrice = BigInt(bestAsk.price);
  const bidTick = BigInt(bestBid.tick);
  const askTick = BigInt(bestAsk.tick);
  const spread = askPrice - bidPrice;
  const mid = (askPrice + bidPrice) / 2n;
  el.spreadValue.textContent = `${formatWetc(spread)} WETC`;
  el.midTick.textContent = formatTick((askTick + bidTick) / 2n);
  el.midPrice.textContent = `${formatWetc(mid)} WETC`;
}

function renderBook(container, levels, side) {
  if (!levels.length) {
    container.innerHTML = "<div class=\"panel-sub\">No levels.</div>";
    return;
  }
  const maxLots = Math.max(...levels.map((lvl) => toNumber(lvl.totalLots)), 1);
  container.innerHTML = levels
    .map((lvl, idx) => {
      const depth = Math.round((toNumber(lvl.totalLots) / maxLots) * 100);
      const price = formatWetc(lvl.price);
      const lots = formatLots(lvl.totalLots);
      const total = formatWetc(lvl.totalValue);
      return `
        <div class="book-row ${side}${idx === 0 ? " best" : ""}">
          <div class="bar" style="width:${depth}%;${side === "buy" ? "right:0;" : "left:0;"}"></div>
          <span>${price}</span>
          <span>${lots}</span>
          <span>${total}</span>
        </div>
      `;
    })
    .join("");
}

function renderOrders(buyOrders, sellOrders) {
  const rows = [];
  buyOrders.forEach((order) => {
    rows.push({
      side: "buy",
      id: order.id,
      owner: order.owner,
      tick: order.tick,
      price: order.price,
      lots: order.lotsRemaining
    });
  });
  sellOrders.forEach((order) => {
    rows.push({
      side: "sell",
      id: order.id,
      owner: order.owner,
      tick: order.tick,
      price: order.price,
      lots: order.lotsRemaining
    });
  });
  const limited = rows.slice(0, 12);
  el.openOrders.innerHTML = limited.length
    ? limited
        .map(
          (row) => {
            const isOwner =
              state.walletAddress &&
              row.owner &&
              row.owner.toLowerCase() === state.walletAddress;
            const action = isOwner
              ? `<button class="btn ghost mini" data-cancel="${row.id}">Cancel</button>`
              : `<span class="meta-label">--</span>`;
            return `
        <div class="table-row orders">
          <span class="tag ${row.side}">${row.side.toUpperCase()}</span>
          <span>#${row.id}</span>
          <span>${formatTick(row.tick)} @ ${formatWetc(row.price)}</span>
          <span>${formatLots(row.lots)} lots</span>
          ${action}
        </div>
      `;
          }
        )
        .join("")
    : "<div class=\"panel-sub\">No open orders.</div>";
}

function renderTape() {
  const entries = state.tape.slice(0, 10);
  el.recentTrades.innerHTML = entries.length
    ? entries
        .map(
          (trade) => `
        <div class="table-row">
          <span>${trade.side.toUpperCase()}</span>
          <span>${formatTick(trade.tick)} @ ${formatWetc(trade.price)}</span>
          <span>${formatLots(trade.lots)} lots</span>
        </div>
      `
        )
        .join("")
    : "<div class=\"panel-sub\">No trades yet.</div>";
}

function updateChart(buy, sell) {
  const ctx = el.sparkline.getContext("2d");
  const width = el.sparkline.width;
  const height = el.sparkline.height;
  ctx.clearRect(0, 0, width, height);

  const points = [...sell.slice(0, 8), ...buy.slice(0, 8)]
    .map((lvl) => Number(ethers.formatUnits(lvl.price, 18)))
    .filter((val) => Number.isFinite(val));

  if (!points.length) return;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;

  ctx.strokeStyle = "rgba(244, 184, 96, 0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((val, idx) => {
    const x = (idx / (points.length - 1 || 1)) * (width - 20) + 10;
    const y = height - ((val - min) / range) * (height - 40) - 20;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function buildDemoBook(side) {
  const base = side === "buy" ? 120 : 121;
  return Array.from({ length: 10 }, (_, i) => {
    const tick = BigInt(side === "buy" ? base - i : base + i);
    const price = 500000000000000000n + BigInt(i) * 10000000000000000n;
    const lots = BigInt(60 - i * 4);
    const total = lots * price;
    return {
      tick,
      price,
      totalLots: lots,
      totalValue: total,
      orderCount: BigInt(2 + i)
    };
  });
}

function buildDemoOrders(isSell = false) {
  return Array.from({ length: 6 }, (_, i) => ({
    id: BigInt(300 + i),
    owner: "0x0000000000000000000000000000000000000000",
    tick: BigInt(isSell ? 124 + i : 118 - i),
    price: 520000000000000000n + BigInt(i) * 9000000000000000n,
    lotsRemaining: BigInt(12 + i * 3),
    valueRemaining: BigInt(12 + i * 3) * (520000000000000000n + BigInt(i) * 9000000000000000n)
  }));
}

async function refresh() {
  const depth = Number(el.depthInput.value) || MAX_LEVELS_DEFAULT;
  const maxOrders = MAX_ORDERS_DEFAULT;

  try {
    const snapshot = await getMarketSnapshot(depth, maxOrders);
    const toLevel = (level) => ({
      ...level,
      tick: BigInt(level.tick), price: BigInt(level.price), totalLots: BigInt(level.totalLots),
      totalValue: BigInt(level.totalValue), orderCount: BigInt(level.orderCount)
    });
    const toOrder = (order) => ({
      ...order,
      id: BigInt(order.id), tick: BigInt(order.tick), price: BigInt(order.price),
      lotsRemaining: BigInt(order.lotsRemaining), valueRemaining: BigInt(order.valueRemaining)
    });
    const buyLevels = snapshot.buyBook.levels.map(toLevel);
    const sellLevels = snapshot.sellBook.levels.map(toLevel);
    const buyOrdersList = snapshot.buyOrders.orders.map(toOrder);
    const sellOrdersList = snapshot.sellOrders.orders.map(toOrder);

    setStatus("Live", true);
    el.emptyBanner.hidden = !(buyLevels.length === 0 && sellLevels.length === 0);
    const sourceLabel = "API";
    const chainLabel = state.readChainId ? ` chain ${state.readChainId}` : "";
    el.chainStatus.textContent = `${sourceLabel}${chainLabel}`;
    renderBook(el.buyBook, buyLevels, "buy");
    renderBook(el.sellBook, sellLevels, "sell");
    updateSpread(buyLevels.length ? buyLevels[0] : null, sellLevels.length ? sellLevels[0] : null);
    renderOrders(buyOrdersList, sellOrdersList);
    updateChart(buyLevels, sellLevels);

    const { oracle } = snapshot;
    const bestBuyTick = BigInt(oracle.bestBuyTick);
    const bestSellTick = BigInt(oracle.bestSellTick);
    const lastTradeTick = BigInt(oracle.lastTradeTick);
    const lastTradeBlock = BigInt(oracle.lastTradeBlock);
    const lastTradePrice = BigInt(oracle.lastTradePrice);
    el.bestBid.textContent = bestBuyTick === NONE ? "--" : `${formatTick(bestBuyTick)} @ ${formatWetc(buyLevels[0]?.price || 0n)}`;
    el.bestAsk.textContent = bestSellTick === NONE ? "--" : `${formatTick(bestSellTick)} @ ${formatWetc(sellLevels[0]?.price || 0n)}`;
    el.lastTrade.textContent = `${formatTick(lastTradeTick)} @ ${formatWetc(lastTradePrice)}`;
    el.lastBlock.textContent = lastTradeBlock.toString();

    const buyWETC = BigInt(snapshot.escrow.buyWETC);
    const sellSTRN10K = BigInt(snapshot.escrow.sellSTRN10K);
    el.escrowTotals.textContent = `${formatWetc(buyWETC)} WETC / ${formatLots(sellSTRN10K)} lots`;
    const totalLots = [...buyLevels, ...sellLevels].reduce(
      (acc, lvl) => acc + BigInt(lvl.totalLots),
      0n
    );
    el.liquidity.textContent = `${formatLots(totalLots)} lots`;

    const hasTrade = lastTradeBlock !== 0n;
    const tradeUpdated =
      state.lastTradeBlock !== null &&
      state.lastTradeBlock !== lastTradeBlock &&
      hasTrade;
    if (tradeUpdated) {
      state.tape.unshift({
        side: "trade",
        tick: lastTradeTick,
        price: lastTradePrice,
        lots: 1n
      });
      pulse(el.lastTradeStat);
      pulse(el.statusPill);
    }
    state.lastTradeTick = lastTradeTick;
    state.lastTradeBlock = lastTradeBlock;
    renderTape();

    el.lastUpdate.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    setDemoMode(errorMessage(err));
  }
}

async function previewOrder() {
  const tick = Number(el.tickInput.value);
  const lots = Number(el.lotsInput.value);
  if (!Number.isFinite(tick) || !Number.isFinite(lots) || lots <= 0) {
    setTicketStatus("Enter a valid tick and lots.");
    return;
  }
  try {
    const price = await getPriceAtTick(tick);
    const total = price * BigInt(lots);
    el.previewPrice.textContent = `${formatWetc(price)} WETC`;
    el.previewValue.textContent = `${formatWetc(total)} WETC`;
  } catch (err) {
    setTicketStatus(`Preview error: ${err.message || err}`);
  }
}

async function placeOrder() {
  if (!state.writeContract) {
    setTicketStatus("Connect a wallet to trade.");
    return;
  }
  const tick = Number(el.tickInput.value);
  const lots = Number(el.lotsInput.value);
  if (!Number.isFinite(tick) || !Number.isFinite(lots) || lots <= 0) {
    setTicketStatus("Enter a valid tick and lots.");
    return;
  }
  try {
    setTicketStatus("Submitting transaction...");
    const tx =
      state.side === "buy"
        ? await state.writeContract.placeBuy(tick, lots)
        : await state.writeContract.placeSell(tick, lots);
    await tx.wait();
    setTicketStatus("Order placed.");
    await refresh();
  } catch (err) {
    setTicketStatus(`Tx failed: ${err.message || err}`);
  }
}

async function cancelOrder(id) {
  if (!state.writeContract) {
    setTicketStatus("Connect a wallet to cancel orders.");
    return;
  }
  try {
    setTicketStatus(`Canceling #${id}...`);
    const tx = await state.writeContract.cancel(id);
    await tx.wait();
    setTicketStatus(`Canceled #${id}.`);
    await refresh();
  } catch (err) {
    setTicketStatus(`Cancel failed: ${err.message || err}`);
  }
}

async function clearMyOrders() {
  if (!state.writeContract || !state.walletAddress) {
    setTicketStatus("Connect a wallet to clear orders.");
    return;
  }
  try {
    setTicketStatus("Canceling your orders...");
    const [buyRes, sellRes] = await Promise.all([
      state.walletReadContract.getBuyOrders(MAX_ORDERS_DEFAULT),
      state.walletReadContract.getSellOrders(MAX_ORDERS_DEFAULT)
    ]);
    const [buyOrders, buyN] = buyRes;
    const [sellOrders, sellN] = sellRes;
    const orders = [
      ...Array.from(buyOrders).slice(0, toNumber(buyN)),
      ...Array.from(sellOrders).slice(0, toNumber(sellN))
    ].filter((o) => o.owner && o.owner.toLowerCase() === state.walletAddress);

    for (const order of orders) {
      const tx = await state.writeContract.cancel(order.id);
      await tx.wait();
    }

    setTicketStatus(orders.length ? "All your orders canceled." : "No orders to cancel.");
    await refresh();
  } catch (err) {
    setTicketStatus(`Cancel failed: ${err.message || err}`);
  }
}

async function seedOrders() {
  if (!state.writeContract || !state.signer) {
    setTicketStatus("Connect a wallet to seed orders.");
    return;
  }
  if (!state.wetc || !state.strn10k) {
    setTicketStatus("Token addresses missing for seeding.");
    return;
  }
  try {
    const [buyRes, sellRes] = await Promise.all([
      state.walletReadContract.getBuyBook(1),
      state.walletReadContract.getSellBook(1)
    ]);
    if (toNumber(buyRes[1]) > 0 || toNumber(sellRes[1]) > 0) {
      setTicketStatus("Book already has orders.");
      return;
    }

    const sellSeeds = [
      { tick: 121, lots: 60 },
      { tick: 122, lots: 56 },
      { tick: 123, lots: 52 },
      { tick: 124, lots: 48 },
      { tick: 125, lots: 44 }
    ];

    const buySeeds = [
      { tick: 120, lots: 60 },
      { tick: 119, lots: 56 },
      { tick: 118, lots: 52 },
      { tick: 117, lots: 48 },
      { tick: 116, lots: 44 }
    ];

    const owner = await state.signer.getAddress();
    const wetc = state.wetc.connect(state.signer);
    const strn10k = state.strn10k.connect(state.signer);

    let neededWetc = 0n;
    for (const order of buySeeds) {
      const price = await state.walletReadContract.priceAtTick(order.tick);
      neededWetc += price * BigInt(order.lots);
    }
    const neededStrn10k = sellSeeds.reduce((acc, order) => acc + BigInt(order.lots), 0n);

    const [wetcAllowance, strn10kAllowance] = await Promise.all([
      wetc.allowance(owner, CONTRACT_ADDRESS),
      strn10k.allowance(owner, CONTRACT_ADDRESS)
    ]);

    if (wetcAllowance < neededWetc) {
      const tx = await wetc.approve(CONTRACT_ADDRESS, ethers.MaxUint256);
      await tx.wait();
    }
    if (strn10kAllowance < neededStrn10k) {
      const tx = await strn10k.approve(CONTRACT_ADDRESS, ethers.MaxUint256);
      await tx.wait();
    }

    setTicketStatus("Seeding orders...");
    for (const order of sellSeeds) {
      const tx = await state.writeContract.placeSell(order.tick, order.lots);
      await tx.wait();
    }
    for (const order of buySeeds) {
      const tx = await state.writeContract.placeBuy(order.tick, order.lots);
      await tx.wait();
    }

    setTicketStatus("Seeded the book.");
    await refresh();
  } catch (err) {
    setTicketStatus(`Seed failed: ${err.message || err}`);
  }
}

function bindEvents() {
  el.connectBtn.addEventListener("click", connectWallet);
  if (el.copyBtn) {
    el.copyBtn.addEventListener("click", copyAddresses);
  }
  if (el.addWetc) {
    el.addWetc.addEventListener("click", () => addTokenToWallet(WETC_ADDRESS, "WETC", 18));
  }
  if (el.addStrn10k) {
    el.addStrn10k.addEventListener("click", () => addTokenToWallet(STRN10K_ADDRESS, "STRN10K", 0));
  }
  el.refreshBtn.addEventListener("click", refresh);
  el.previewBtn.addEventListener("click", previewOrder);
  el.placeBtn.addEventListener("click", placeOrder);
  if (el.takeBtn) el.takeBtn.addEventListener("click", takeOrder);
  el.depthInput.addEventListener("change", () => {
    const value = Number(el.depthInput.value);
    if (Number.isFinite(value)) {
      updateDepthToggle(value);
    }
    refresh();
  });
  el.seedBtn.addEventListener("click", seedOrders);
  el.clearBtn.addEventListener("click", clearMyOrders);
  el.openOrders.addEventListener("click", (event) => {
    const target = event.target.closest("[data-cancel]");
    if (!target) return;
    const id = target.getAttribute("data-cancel");
    if (id) cancelOrder(id);
  });

  el.sideToggle.addEventListener("click", (event) => {
    const button = event.target.closest(".seg");
    if (!button) return;
    const side = button.dataset.side;
    state.side = side;
    el.sideToggle.querySelectorAll(".seg").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.side === side);
    });
  });

  if (el.depthToggle) {
    el.depthToggle.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      const value = Number(chip.dataset.depth);
      if (!Number.isFinite(value)) return;
      setDepth(value);
    });
  }
}

async function boot() {
  bindEvents();
  el.depthInput.value = MAX_LEVELS_DEFAULT.toString();
  updateDepthToggle(MAX_LEVELS_DEFAULT);
  el.seedBtn.disabled = true;
  el.clearBtn.disabled = true;
  try {
    await initProvider();
    const health = await fetchApi("/health");
    state.readChainId = Number(health.chainId);
  } catch (err) {
    setDemoMode(err.message || "Read API unavailable");
    return;
  }
  await refresh();
  setInterval(refresh, 3000);
}

boot();
