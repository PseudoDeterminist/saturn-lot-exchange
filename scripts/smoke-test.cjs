const fs = require('fs');
const path = require('path');
const hre = require('hardhat');
const ethers = hre.ethers;

function parseEnv(envText) {
  const out = {};
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function main() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) throw new Error('.env not found');
  const env = parseEnv(fs.readFileSync(envPath, 'utf8'));

  const tradeAddr = env.SIMPLE_LOT_TRADE_ADDRESS || env.SATURN_LOT_TRADE_ADDRESS || env.MAINNET_SATURN_LOT_TRADE_ADDRESS;
  const wetcAddr = env.WETC_ADDRESS || env.TETC_ADDRESS || env.MAINNET_WETC_ADDRESS;
  const strnAddr = env.STRN10K_ADDRESS || env.TKN10K_ADDRESS || env.MAINNET_STRN10K_ADDRESS;

  if (!tradeAddr) throw new Error('Could not find trade contract address in .env');
  if (!wetcAddr) throw new Error('Could not find WETC address in .env');
  if (!strnAddr) throw new Error('Could not find STRN10K address in .env');

  console.log('Using RPC provider from Hardhat runtime');
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  console.log('Signer:', deployerAddr);

  const tradeAbi = [
    'function historyHash() view returns (bytes32)',
    'function buyFOK(int256,uint256,uint256)',
    'function buyFOK(int256,uint256,uint256,bytes32)',
    'function sellFOK(int256,uint256,uint256)',
    'function sellFOK(int256,uint256,uint256,bytes32)',
    'function getTopOfBook() view returns (int256,uint256,uint256,int256,uint256,uint256)',
    'function getBuyBook(uint256) view returns (tuple(int256 tick,uint256 price,uint256 totalLots,uint256 totalValue,uint256 orderCount)[], uint256)',
    'function getSellBook(uint256) view returns (tuple(int256 tick,uint256 price,uint256 totalLots,uint256 totalValue,uint256 orderCount)[], uint256)'
  ];

  const erc20Abi = [
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)',
    'function balanceOf(address) view returns (uint256)'
  ];

  const trade = new ethers.Contract(tradeAddr, tradeAbi, deployer);
  const wetc = new ethers.Contract(wetcAddr, erc20Abi, deployer);
  const strn = new ethers.Contract(strnAddr, erc20Abi, deployer);

  console.log('Trade:', tradeAddr, 'WETC:', wetcAddr, 'STRN10K:', strnAddr);

  const history = await trade.historyHash();
  console.log('historyHash:', history);

  const top = await trade.getTopOfBook();
  console.log('rawTop:', top);
  // Convert small tuple values to native numbers/strings for logic
  const bestBuyTick = Number(top[0].toString());
  const buyLots = Number(top[1].toString());
  const buyOrders = Number(top[2].toString());
  const bestSellTick = Number(top[3].toString());
  const sellLots = Number(top[4].toString());
  const sellOrders = Number(top[5].toString());

  console.log('Top of book:', {
    bestBuyTick: String(bestBuyTick),
    buyLots: String(buyLots),
    bestSellTick: String(bestSellTick),
    sellLots: String(sellLots)
  });

    if (sellLots > 0) {
    console.log('Attempting buyFOK for 1 lot at sell top');
    const sb = await trade.getSellBook(1);
    const levels = sb[0];
    const n = sb[1];
      if (Number(n.toString()) === 0) throw new Error('Unexpected: sell book empty');
    const lvl = levels[0];
    const price = BigInt(lvl.price.toString());
    const lots = 1n;
    const cost = price * lots;
    const maxWetcIn = cost * 2n;

    const bal = await wetc.balanceOf(deployerAddr);
    const balBig = BigInt(bal.toString());
    console.log('WETC balance:', bal.toString(), 'required:', cost.toString());
    if (balBig < cost) throw new Error('Insufficient WETC balance for buyFOK test');

    const approveTx = await wetc.approve(tradeAddr, maxWetcIn.toString());
    await approveTx.wait();
    console.log('Approved WETC to trade:', maxWetcIn.toString());

    const tx = await trade.buyFOK(bestSellTick, 1, maxWetcIn.toString(), history, { gasLimit: 8000000 });
    console.log('buyFOK tx sent:', tx.hash);
    const r = await tx.wait();
    console.log('buyFOK tx mined, status:', r.status);
    return;
  }

    if (buyLots > 0) {
    console.log('Attempting sellFOK for 1 lot at buy top');
    const bb = await trade.getBuyBook(1);
    const levels = bb[0];
    const n = bb[1];
      if (Number(n.toString()) === 0) throw new Error('Unexpected: buy book empty');
    const lvl = levels[0];
    const price = BigInt(lvl.price.toString());
    const lots = 1n;
    const minWetcOut = price * lots;

    const bal = await strn.balanceOf(deployerAddr);
    const balBig = BigInt(bal.toString());
    console.log('STRN10K balance:', bal.toString(), 'required lots:', lots.toString());
    if (balBig < lots) throw new Error('Insufficient STRN10K balance for sellFOK test');

    const approveTx = await strn.approve(tradeAddr, lots.toString());
    await approveTx.wait();
    console.log('Approved STRN10K to trade:', lots.toString());

    const tx = await trade.sellFOK(bestBuyTick, 1, minWetcOut.toString(), history, { gasLimit: 8000000 });
    console.log('sellFOK tx sent:', tx.hash);
    const r = await tx.wait();
    console.log('sellFOK tx mined, status:', r.status);
    return;
  }

  console.log('No orders on book to test taker FOK');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Smoke test failed:', err);
    process.exit(1);
  });
