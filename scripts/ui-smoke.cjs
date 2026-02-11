const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const env = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  const RPC_URL = env.ETC_RPC_URL || env.MORDOR_RPC_URL || 'http://127.0.0.1:8545';
  const TRADE = env.SIMPLE_LOT_TRADE_ADDRESS || env.SATURN_LOT_TRADE_ADDRESS || env.MAINNET_SATURN_LOT_TRADE_ADDRESS;

  if (!TRADE) throw new Error('Trade address missing in .env');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const accounts = await provider.listAccounts();
  if (!accounts || accounts.length === 0) throw new Error('No accounts available on RPC');
  const account = accounts[0];
  console.log('Using RPC', RPC_URL, 'with account', account);

  const ABI = [
    'function getTopOfBook() view returns (int256,uint256,uint256,int256,uint256,uint256)',
    'function getSellBook(uint256) view returns (tuple(int256 tick,uint256 price,uint256 totalLots,uint256 totalValue,uint256 orderCount)[] out,uint256 n)',
    'function historyHash() view returns (bytes32)'
  ];

  const trade = new ethers.Contract(TRADE, ABI, provider);
  const top = await trade.getTopOfBook();
  const bestSellTick = Number(top[3].toString());
  const sellLots = Number(top[4].toString());
  console.log('Top:', top.map(x => x.toString()));

  if (sellLots === 0) {
    console.log('No sell lots on book; cannot exercise buyFOK via UI. Aborting.');
    process.exit(0);
  }

  const sb = await trade.getSellBook(1);
  const lvl = sb[0][0];
  const price = BigInt(lvl.price.toString());
  const priceStr = ethers.formatUnits(price.toString(), 18);

  // Launch browser and inject a minimal window.ethereum shim that returns accounts and forwards JSON-RPC
  const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox','--disable-setuid-sandbox']});
  const page = await browser.newPage();

  // Expose RPC URL and account inside the page before any scripts run
  await page.evaluateOnNewDocument((rpc, acct) => {
    window.__INJECTED_RPC = rpc;
    window.__INJECTED_ACCOUNT = acct.toLowerCase();
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return [window.__INJECTED_ACCOUNT];
        }
        if (method === 'wallet_watchAsset') {
          // emulate acceptance
          return true;
        }
        // Forward other methods to the RPC
        const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
        const res = await fetch(window.__INJECTED_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const obj = await res.json();
        if (obj.error) throw new Error(obj.error.message || 'RPC error');
        return obj.result;
      }
    };
    // Minimal event emitter
    window.ethereum.on = () => {};
  }, RPC_URL, account);

  page.on('console', msg => {
    console.log('PAGE:', msg.text());
  });

  const url = 'http://127.0.0.1:8000';
  console.log('Loading UI at', url);
  await page.goto(url, { waitUntil: 'networkidle2' });

  // ensure window.ethereum exists in the page (some apps bind early); inject again in page context and call connectWallet directly
  await page.waitForSelector('#connect-btn', { timeout: 5000 });
  console.log('Ensuring window.ethereum in page and invoking connectWallet');
  await page.evaluate((rpc, acct) => {
    // shim if missing
    if (!window.ethereum) {
      window.__INJECTED_RPC = rpc;
      window.__INJECTED_ACCOUNT = acct.toLowerCase();
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [window.__INJECTED_ACCOUNT];
          if (method === 'wallet_watchAsset') return true;
          const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
          const res = await fetch(window.__INJECTED_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          const obj = await res.json();
          if (obj.error) throw new Error(obj.error.message || 'RPC error');
          return obj.result;
        }
      };
      window.ethereum.on = () => {};
    }
    // call app's connectWallet if defined
    if (typeof window.connectWallet === 'function') {
      window.connectWallet().catch(err => console && console.log && console.log('connectWallet error:', err.message || err));
    }
  }, RPC_URL, account.address ? account.address : account);

  // wait for the connect button to show the short address
  try {
    await page.waitForFunction(() => document.getElementById('connect-btn') && document.getElementById('connect-btn').textContent.startsWith('0x'), { timeout: 15000 });
    console.log('Wallet connected in UI');
  } catch (err) {
    const status = await page.evaluate(() => document.getElementById('ticket-status') ? document.getElementById('ticket-status').textContent : '');
    console.log('Connect timeout; ticket-status:', status);
  }

  // fill taker inputs: limit tick, lots=1, value=price
  await page.evaluate((tick, priceStr) => {
    document.getElementById('taker-limit-input').value = String(tick);
    const lotsEl = document.getElementById('lots-input');
    if (lotsEl) lotsEl.value = '1';
    const takerVal = document.getElementById('taker-value-input');
    if (takerVal) takerVal.value = priceStr;
  }, bestSellTick, priceStr);

  // click take button
  await page.waitForSelector('#take-btn', { timeout: 2000 });
  console.log('Clicking take button');
  await page.click('#take-btn');

  // wait for ticket status change to indicate success or failure
  let final = null;
  for (let i=0;i<60;i++) {
    const status = await page.evaluate(() => document.getElementById('ticket-status') ? document.getElementById('ticket-status').textContent : '');
    console.log('ticket-status:', status);
    if (status.includes('executed') || status.includes('failed') || status.toLowerCase().includes('error') || status.includes('Take failed')) {
      final = status;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Final ticket status:', final);

  await browser.close();
  process.exit(0);
})().catch(err => { console.error('UI smoke failed:', err); process.exit(1); });
