import { expect } from "chai";
import hardhat from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const { ethers } = hardhat;

const MIN_TICK = -464;
const MAX_TICK = 1855;
const MAX_LOTS = 100000n;
const NONE = -(1n << 31n);

const RNG_MOD = 1n << 64n;

function makeRng(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) % RNG_MOD;
    return s;
  };
}

function randIndex(next, max) {
  return Number(next() % BigInt(max));
}

function randBetween(next, min, max) {
  const span = max - min + 1n;
  return min + (next() % span);
}

async function assertBookInvariants(lotrade, orderIds, buyTicks, sellTicks) {
  let buyLots = 0n;
  let buyValue = 0n;
  let sellLots = 0n;
  let sellValue = 0n;
  let bestBuy = NONE;
  let bestSell = NONE;

  const perBuy = new Map();
  const perSell = new Map();
  const priceCache = new Map();

  for (const id of orderIds) {
    const o = await lotrade.orders(id);
    if (o.owner === ethers.ZeroAddress) continue;
    expect(o.lotsRemaining).to.be.greaterThan(0n);

    const key = o.tick.toString();
    let price = priceCache.get(key);
    if (!price) {
      price = await lotrade.priceAtTick(o.tick);
      priceCache.set(key, price);
    }
    expect(o.valueRemaining).to.equal(o.lotsRemaining * price);

    if (o.isBuy) {
      buyLots += o.lotsRemaining;
      buyValue += o.valueRemaining;
      if (bestBuy === NONE || o.tick > bestBuy) bestBuy = o.tick;
      const entry = perBuy.get(key) ?? { tick: o.tick, lots: 0n, value: 0n, count: 0n };
      entry.lots += o.lotsRemaining;
      entry.value += o.valueRemaining;
      entry.count += 1n;
      perBuy.set(key, entry);
    } else {
      sellLots += o.lotsRemaining;
      sellValue += o.valueRemaining;
      if (bestSell === NONE || o.tick < bestSell) bestSell = o.tick;
      const entry = perSell.get(key) ?? { tick: o.tick, lots: 0n, value: 0n, count: 0n };
      entry.lots += o.lotsRemaining;
      entry.value += o.valueRemaining;
      entry.count += 1n;
      perSell.set(key, entry);
    }
  }

  expect(await lotrade.bookEscrowWETC()).to.equal(buyValue);
  expect(await lotrade.bookAskSTRN10K()).to.equal(buyLots);
  expect(await lotrade.bookEscrowSTRN10K()).to.equal(sellLots);
  expect(await lotrade.bookAskWETC()).to.equal(sellValue);

  const onchainBestBuy = await lotrade.bestBuyTick();
  const onchainBestSell = await lotrade.bestSellTick();
  expect(onchainBestBuy).to.equal(buyLots === 0n ? NONE : bestBuy);
  expect(onchainBestSell).to.equal(sellLots === 0n ? NONE : bestSell);

  for (const entry of perBuy.values()) {
    const lvl = await lotrade.buyLevels(entry.tick);
    expect(lvl.price).to.be.greaterThan(0n);
    expect(lvl.totalLots).to.equal(entry.lots);
    expect(lvl.totalValue).to.equal(entry.value);
    expect(lvl.orderCount).to.equal(entry.count);
  }
  for (const entry of perSell.values()) {
    const lvl = await lotrade.sellLevels(entry.tick);
    expect(lvl.price).to.be.greaterThan(0n);
    expect(lvl.totalLots).to.equal(entry.lots);
    expect(lvl.totalValue).to.equal(entry.value);
    expect(lvl.orderCount).to.equal(entry.count);
  }

  for (const tick of buyTicks) {
    const key = tick.toString();
    if (!perBuy.has(key)) {
      const lvl = await lotrade.buyLevels(tick);
      expect(lvl.price).to.equal(0n);
    }
  }
  for (const tick of sellTicks) {
    const key = tick.toString();
    if (!perSell.has(key)) {
      const lvl = await lotrade.sellLevels(tick);
      expect(lvl.price).to.equal(0n);
    }
  }
}

async function deployFixture() {
  const [deployer, alice, bob, carol] = await ethers.getSigners();
  const TestERC20 = await ethers.getContractFactory("TestERC20");
  const wetc = await TestERC20.deploy(
    "WETC",
    "WETC",
    18,
    ethers.parseUnits("1000000", 18)
  );
  const strn10k = await TestERC20.deploy("STRN10K", "STRN10K", 0, 1000000n);
  const SaturnLotTrade = await ethers.getContractFactory("SaturnLotTrade");
  const lotrade = await SaturnLotTrade.deploy(
    await wetc.getAddress(),
    await strn10k.getAddress()
  );

  const wetcAmount = ethers.parseUnits("100000", 18);
  const strn10kAmount = 100000n;
  for (const user of [alice, bob, carol]) {
    await wetc.transfer(user.address, wetcAmount);
    await strn10k.transfer(user.address, strn10kAmount);
  }

  return { deployer, alice, bob, carol, wetc, strn10k, lotrade };
}


describe("SaturnLotTrade", function () {
  it("reverts for out-of-range ticks and is monotonic at bounds", async () => {
    const { lotrade } = await loadFixture(deployFixture);

    await expect(lotrade.priceAtTick(MIN_TICK - 1)).to.be.revertedWith(
      "tick out of range"
    );
    await expect(lotrade.priceAtTick(MAX_TICK + 1)).to.be.revertedWith(
      "tick out of range"
    );

    const pMin = await lotrade.priceAtTick(MIN_TICK);
    const pMinPlus = await lotrade.priceAtTick(MIN_TICK + 1);
    const pMax = await lotrade.priceAtTick(MAX_TICK);
    expect(pMinPlus).to.be.greaterThan(pMin);
    expect(pMax).to.be.greaterThan(pMinPlus);
  });

  it("rejects zero token addresses on deploy", async () => {
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const token = await TestERC20.deploy("Test", "TST", 18, 1000n);
    const SaturnLotTrade = await ethers.getContractFactory("SaturnLotTrade");

    await expect(
      SaturnLotTrade.deploy(ethers.ZeroAddress, await token.getAddress())
    ).to.be.revertedWith("zero WETC");

    await expect(
      SaturnLotTrade.deploy(await token.getAddress(), ethers.ZeroAddress)
    ).to.be.revertedWith("zero STRN10K");
  });

  it("rejects zero or oversized lots", async () => {
    const { lotrade } = await loadFixture(deployFixture);

    await expect(lotrade["placeBuy(int256,uint256)"](0, 0)).to.be.revertedWith("invalid lots");
    await expect(lotrade["placeSell(int256,uint256)"](0, 0)).to.be.revertedWith("invalid lots");
    await expect(lotrade["placeBuy(int256,uint256)"](0, MAX_LOTS + 1n)).to.be.revertedWith(
      "invalid lots"
    );
    await expect(lotrade["placeSell(int256,uint256)"](0, MAX_LOTS + 1n)).to.be.revertedWith(
      "invalid lots"
    );
  });

  it("rejects out-of-range ticks for maker orders", async () => {
    const { lotrade, alice } = await loadFixture(deployFixture);

    await expect(
      lotrade.connect(alice)["placeBuy(int256,uint256)"](MIN_TICK - 1, 1n)
    ).to.be.revertedWith("tick out of range");
    await expect(
      lotrade.connect(alice)["placeBuy(int256,uint256)"](MAX_TICK + 1, 1n)
    ).to.be.revertedWith("tick out of range");
    await expect(
      lotrade.connect(alice)["placeSell(int256,uint256)"](MIN_TICK - 1, 1n)
    ).to.be.revertedWith("tick out of range");
    await expect(
      lotrade.connect(alice)["placeSell(int256,uint256)"](MAX_TICK + 1, 1n)
    ).to.be.revertedWith("tick out of range");
  });

  it("rejects zero lots for taker FOKs", async () => {
    const { lotrade } = await loadFixture(deployFixture);

    await expect(
      lotrade["buyFOK(int256,uint256,uint256)"](0, 0, 0)
    ).to.be.revertedWith("You requested zero lots");
    await expect(
      lotrade["sellFOK(int256,uint256,uint256)"](0, 0, 0)
    ).to.be.revertedWith("You requested zero lots");
  });

  it("reverts taker when book side is empty", async () => {
    const { lotrade } = await loadFixture(deployFixture);

    await expect(
      lotrade["buyFOK(int256,uint256,uint256)"](0, 1n, 1n)
    ).to.be.revertedWith("There are no sell orders on book");
    await expect(
      lotrade["sellFOK(int256,uint256,uint256)"](0, 1n, 0)
    ).to.be.revertedWith("There are no buy orders on book");
  });

  it("reverts taker when lots exceed book totals", async () => {
    const { lotrade, wetc, strn10k, alice } = await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(lotrade, 1n);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](0, 1n)).wait();

    const price = await lotrade.priceAtTick(0);
    await expect(
      lotrade["buyFOK(int256,uint256,uint256)"](0, 2n, price * 2n)
    ).to.be.revertedWith("insufficient escrowed STRN10K on book");

    const buyPrice = await lotrade.priceAtTick(-1);
    await wetc.connect(alice).approve(lotrade, buyPrice);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](-1, 1n)).wait();

    await expect(
      lotrade["sellFOK(int256,uint256,uint256)"](0, 2n, 0)
    ).to.be.revertedWith("FOK--Insufficient asked STRN10K on book");
  });

  it("reverts sell FOK when min output exceeds escrow", async () => {
    const { lotrade, wetc, alice } = await loadFixture(deployFixture);

    const price = await lotrade.priceAtTick(0);
    await wetc.connect(alice).approve(lotrade, price);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](0, 1n)).wait();

    await expect(
      lotrade["sellFOK(int256,uint256,uint256)"](0, 1n, price * 2n)
    ).to.be.revertedWith("FOK--Insufficient escrowed WETC on book");
  });

  it("reverts sell FOK when limit tick blocks fill", async () => {
    const { lotrade, wetc, strn10k, alice, carol } = await loadFixture(deployFixture);

    const price = await lotrade.priceAtTick(0);
    await wetc.connect(alice).approve(lotrade, price);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](0, 1n)).wait();

    await strn10k.connect(carol).approve(lotrade, 1n);
    await expect(
      lotrade.connect(carol)["sellFOK(int256,uint256,uint256)"](1, 1n, 0)
    ).to.be.revertedWith("FOK--Limit tick crossed");
  });

  it("rejects buys that cross the sell book", async () => {
    const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(lotrade, 5n);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](0, 5n)).wait();

    const price = await lotrade.priceAtTick(0);
    await wetc.connect(bob).approve(lotrade, price * 5n);

    await expect(lotrade.connect(bob)["placeBuy(int256,uint256)"](0, 5n)).to.be.revertedWith(
      "crossing sell book -- consider buyFOK"
    );
    await expect(lotrade.connect(bob)["placeBuy(int256,uint256)"](1, 5n)).to.be.revertedWith(
      "crossing sell book -- consider buyFOK"
    );
  });

  it("rejects sells that cross the buy book", async () => {
    const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);

    const price = await lotrade.priceAtTick(0);
    await wetc.connect(alice).approve(lotrade, price * 5n);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](0, 5n)).wait();

    await strn10k.connect(bob).approve(lotrade, 5n);
    await expect(lotrade.connect(bob)["placeSell(int256,uint256)"](0, 5n)).to.be.revertedWith(
      "crossing buy book -- consider sellFOK"
    );
    await expect(lotrade.connect(bob)["placeSell(int256,uint256)"](-1, 5n)).to.be.revertedWith(
      "crossing buy book -- consider sellFOK"
    );
  });

  it("enforces expected hash on maker overloads", async () => {
    const { lotrade, wetc, strn10k, alice } = await loadFixture(deployFixture);

    const tick = 0;
    const lots = 1n;
    const price = await lotrade.priceAtTick(tick);
    await wetc.connect(alice).approve(lotrade, price * lots);
    await strn10k.connect(alice).approve(lotrade, lots);

    const hash = await lotrade.historyHash();
    await (
      await lotrade
        .connect(alice)
        ["placeBuy(int256,uint256,bytes32)"](tick, lots, hash)
    ).wait();

    await (
      await lotrade
        .connect(alice)
        ["placeSell(int256,uint256,bytes32)"](tick + 1, lots, await lotrade.historyHash())
    ).wait();

    await expect(
      lotrade
        .connect(alice)
        ["placeBuy(int256,uint256,bytes32)"](tick + 2, lots, hash)
    ).to.be.revertedWith("stale hash");

    await expect(
      lotrade
        .connect(alice)
        ["placeSell(int256,uint256,bytes32)"](tick + 3, lots, hash)
    ).to.be.revertedWith("stale hash");
  });

  it("enforces expected hash on taker overloads", async () => {
    const { lotrade, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    const tick = 0;
    const lots = 1n;

    await strn10k.connect(alice).approve(lotrade, lots);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](tick, lots)).wait();

    const price = await lotrade.priceAtTick(tick);
    const maxWetcIn = price * lots;
    const hash = await lotrade.historyHash();

    await wetc.connect(bob).approve(lotrade, maxWetcIn);
    await (
      await lotrade
        .connect(bob)
        ["buyFOK(int256,uint256,uint256,bytes32)"](
          tick,
          lots,
          maxWetcIn,
          hash
        )
    ).wait();

    await expect(
      lotrade
        .connect(bob)
        ["buyFOK(int256,uint256,uint256,bytes32)"](
          tick,
          lots,
          maxWetcIn,
          hash
        )
    ).to.be.revertedWith("stale hash");

    await wetc.connect(alice).approve(lotrade, price * lots);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](tick, lots)).wait();

    const sellHash = await lotrade.historyHash();
    await strn10k.connect(carol).approve(lotrade, lots);
    await (
      await lotrade
        .connect(carol)
        ["sellFOK(int256,uint256,uint256,bytes32)"](
          tick,
          lots,
          price * lots,
          sellHash
        )
    ).wait();

    await expect(
      lotrade
        .connect(carol)
        ["sellFOK(int256,uint256,uint256,bytes32)"](
          tick,
          lots,
          price * lots,
          sellHash
        )
    ).to.be.revertedWith("stale hash");
  });

  it("fills orders FIFO within a tick", async () => {
    const { lotrade, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);
    const tick = 0;

    await strn10k.connect(alice).approve(lotrade, 5n);
    await strn10k.connect(bob).approve(lotrade, 5n);

    const id1 = await lotrade.connect(alice)["placeSell(int256,uint256)"].staticCall(tick, 5n);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](tick, 5n)).wait();
    const id2 = await lotrade.connect(bob)["placeSell(int256,uint256)"].staticCall(tick, 5n);
    await (await lotrade.connect(bob)["placeSell(int256,uint256)"](tick, 5n)).wait();

    const price = await lotrade.priceAtTick(tick);
    const buyLots = 3n;
    const maxWetcIn = price * buyLots;
    await wetc.connect(carol).approve(lotrade, maxWetcIn);
    await (await lotrade.connect(carol)["buyFOK(int256,uint256,uint256)"](tick, buyLots, maxWetcIn)).wait();

    const order1 = await lotrade.orders(id1);
    const order2 = await lotrade.orders(id2);
    expect(order1.lotsRemaining).to.equal(2n);
    expect(order2.lotsRemaining).to.equal(5n);

    const lvl = await lotrade.sellLevels(tick);
    expect(lvl.orderCount).to.equal(2n);
    expect(lvl.totalLots).to.equal(7n);
  });

  it("reverts FOK when limit tick blocks full fill (no state change)", async () => {
    const { lotrade, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(lotrade, 5n);
    await strn10k.connect(bob).approve(lotrade, 4n);
    const id1 = await lotrade.connect(alice)["placeSell(int256,uint256)"].staticCall(0, 5n);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](0, 5n)).wait();
    const id2 = await lotrade.connect(bob)["placeSell(int256,uint256)"].staticCall(1, 4n);
    await (await lotrade.connect(bob)["placeSell(int256,uint256)"](1, 4n)).wait();

    const price0 = await lotrade.priceAtTick(0);
    const price1 = await lotrade.priceAtTick(1);
    const maxWetcIn = price0 * 5n + price1 * 4n;
    await wetc.connect(carol).approve(lotrade, maxWetcIn);

    await expect(lotrade.connect(carol)["buyFOK(int256,uint256,uint256)"](0, 9n, maxWetcIn)).to.be.revertedWith(
      "FOK--Limit tick crossed"
    );

    const order1 = await lotrade.orders(id1);
    const order2 = await lotrade.orders(id2);
    expect(order1.lotsRemaining).to.equal(5n);
    expect(order2.lotsRemaining).to.equal(4n);

    const totals = await lotrade.getEscrowTotals();
    expect(totals[1]).to.equal(9n);
  });

  it("reverts buy FOK on slippage before state updates", async () => {
    const { lotrade, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(lotrade, 5n);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](0, 5n)).wait();

    const price = await lotrade.priceAtTick(0);
    const cost = price * 5n;
    await wetc.connect(carol).approve(lotrade, cost - 1n);
    await expect(
      lotrade.connect(carol)["buyFOK(int256,uint256,uint256)"](0, 5n, cost - 1n)
    ).to.be.revertedWith("FOK--Slippage exceeded");

    const lvl = await lotrade.sellLevels(0);
    expect(lvl.totalLots).to.equal(5n);
  });

  it("fills across ticks and updates oracle fields", async () => {
    const { lotrade, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(lotrade, 5n);
    await strn10k.connect(bob).approve(lotrade, 4n);
    const id1 = await lotrade.connect(alice)["placeSell(int256,uint256)"].staticCall(0, 5n);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](0, 5n)).wait();
    const id2 = await lotrade.connect(bob)["placeSell(int256,uint256)"].staticCall(1, 4n);
    await (await lotrade.connect(bob)["placeSell(int256,uint256)"](1, 4n)).wait();

    const price0 = await lotrade.priceAtTick(0);
    const price1 = await lotrade.priceAtTick(1);
    const maxWetcIn = price0 * 5n + price1 * 2n;
    await wetc.connect(carol).approve(lotrade, maxWetcIn);
    await (await lotrade.connect(carol)["buyFOK(int256,uint256,uint256)"](1, 7n, maxWetcIn)).wait();

    const order1 = await lotrade.orders(id1);
    const order2 = await lotrade.orders(id2);
    expect(order1.owner).to.equal(ethers.ZeroAddress);
    expect(order2.lotsRemaining).to.equal(2n);

    expect(await lotrade.bestSellTick()).to.equal(1n);
    expect(await lotrade.lastTradeTick()).to.equal(1n);
    expect(await lotrade.lastTradePrice()).to.equal(price1);

    const totals = await lotrade.getEscrowTotals();
    expect(totals[1]).to.equal(2n);
    expect(await lotrade.bookAskWETC()).to.equal(price1 * 2n);
  });

  it("refunds unused quote in buy FOK", async () => {
    const { lotrade, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    await strn10k.connect(alice).approve(lotrade, 3n);
    await (await lotrade.connect(alice)["placeSell(int256,uint256)"](0, 3n)).wait();

    const price = await lotrade.priceAtTick(0);
    const cost = price * 3n;
    const maxWetcIn = cost + 1n;

    const before = await wetc.balanceOf(carol.address);
    await wetc.connect(carol).approve(lotrade, maxWetcIn);
    await (await lotrade.connect(carol)["buyFOK(int256,uint256,uint256)"](0, 3n, maxWetcIn)).wait();
    const after = await wetc.balanceOf(carol.address);

    expect(before - after).to.equal(cost);
  });

  it("reverts sell FOK when min output is too high", async () => {
    const { lotrade, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    const price = await lotrade.priceAtTick(0);
    const cost = price * 10n;

    await wetc.connect(alice).approve(lotrade, cost);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](0, 10n)).wait();

    await strn10k.connect(carol).approve(lotrade, 5n);
    await expect(
      lotrade.connect(carol)["sellFOK(int256,uint256,uint256)"](0, 5n, price * 5n + 1n)
    ).to.be.revertedWith("FOK--Slippage exceeded");
  });

  it("allows partial fills then cancel refunds remaining escrow", async () => {
    const { lotrade, wetc, strn10k, alice, carol } =
      await loadFixture(deployFixture);

    const price = await lotrade.priceAtTick(0);
    const cost = price * 10n;

    await wetc.connect(alice).approve(lotrade, cost);
    const id = await lotrade.connect(alice)["placeBuy(int256,uint256)"].staticCall(0, 10n);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](0, 10n)).wait();

    await strn10k.connect(carol).approve(lotrade, 4n);
    await (await lotrade.connect(carol)["sellFOK(int256,uint256,uint256)"](0, 4n, 0)).wait();

    const order = await lotrade.orders(id);
    expect(order.lotsRemaining).to.equal(6n);

    const before = await wetc.balanceOf(alice.address);
    await (await lotrade.connect(alice).cancel(id)).wait();
    const after = await wetc.balanceOf(alice.address);

    expect(after - before).to.equal(price * 6n);
    expect(await lotrade.bookEscrowWETC()).to.equal(0n);
    expect(await lotrade.bookAskSTRN10K()).to.equal(0n);
  });

  it("rejects cancel from non-owner", async () => {
    const { lotrade, wetc, alice, bob } = await loadFixture(deployFixture);

    const price = await lotrade.priceAtTick(0);
    await wetc.connect(alice).approve(lotrade, price);
    const id = await lotrade.connect(alice)["placeBuy(int256,uint256)"].staticCall(0, 1n);
    await (await lotrade.connect(alice)["placeBuy(int256,uint256)"](0, 1n)).wait();

    await expect(lotrade.connect(bob).cancel(id)).to.be.revertedWith("not order owner");
  });

  it("maintains book invariants under randomized actions (multi-seed)", async () => {
    const { lotrade, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    const actors = [alice, bob, carol];
    const maxWetc = ethers.parseUnits("100000", 18);
    for (const actor of actors) {
      await wetc.connect(actor).approve(lotrade, maxWetc);
      await strn10k.connect(actor).approve(lotrade, 100000n);
    }

    const orderIds = [];
    const buyTicks = new Set();
    const sellTicks = new Set();
    const TICK_MIN = -10n;
    const TICK_MAX = 10n;
    const seeds = [123n, 999n];
    const steps = 80;

    for (const seed of seeds) {
      const nextRand = makeRng(seed);
      for (let i = 0; i < steps; i++) {
        const actor = actors[randIndex(nextRand, actors.length)];
        const action = randIndex(nextRand, 5);
        let didWork = false;

        if (action === 0) {
          let maxTick = TICK_MAX;
          const bestSell = await lotrade.bestSellTick();
          if (bestSell !== NONE) maxTick = bestSell - 1n;
          if (maxTick >= TICK_MIN) {
            const tick = randBetween(nextRand, TICK_MIN, maxTick);
            const lots = randBetween(nextRand, 1n, 5n);
            const id = await lotrade.connect(actor)["placeBuy(int256,uint256)"].staticCall(tick, lots);
            await lotrade.connect(actor)["placeBuy(int256,uint256)"](tick, lots);
            orderIds.push(id);
            buyTicks.add(tick);
            didWork = true;
          }
        } else if (action === 1) {
          let minTick = TICK_MIN;
          const bestBuy = await lotrade.bestBuyTick();
          if (bestBuy !== NONE) minTick = bestBuy + 1n;
          if (minTick <= TICK_MAX) {
            const tick = randBetween(nextRand, minTick, TICK_MAX);
            const lots = randBetween(nextRand, 1n, 5n);
            const id = await lotrade.connect(actor)["placeSell(int256,uint256)"].staticCall(tick, lots);
            await lotrade.connect(actor)["placeSell(int256,uint256)"](tick, lots);
            orderIds.push(id);
            sellTicks.add(tick);
            didWork = true;
          }
        } else if (action === 2) {
          const available = await lotrade.bookEscrowSTRN10K();
          const maxWetcIn = await lotrade.bookAskWETC();
          if (available > 0n && maxWetcIn > 0n) {
            const maxLots = available < 5n ? available : 5n;
            const lots = randBetween(nextRand, 1n, maxLots);
            await lotrade.connect(actor)["buyFOK(int256,uint256,uint256)"](MAX_TICK, lots, maxWetcIn);
            didWork = true;
          }
        } else if (action === 3) {
          const available = await lotrade.bookAskSTRN10K();
          if (available > 0n) {
            const maxLots = available < 5n ? available : 5n;
            const lots = randBetween(nextRand, 1n, maxLots);
            await lotrade.connect(actor)["sellFOK(int256,uint256,uint256)"](MIN_TICK, lots, 0);
            didWork = true;
          }
        } else {
          if (orderIds.length > 0) {
            const id = orderIds[randIndex(nextRand, orderIds.length)];
            const o = await lotrade.orders(id);
            if (o.owner !== ethers.ZeroAddress && o.owner === actor.address) {
              await lotrade.connect(actor).cancel(id);
              didWork = true;
            }
          }
        }

        if (didWork) {
          await assertBookInvariants(lotrade, orderIds, buyTicks, sellTicks);
        }
      }
    }
  });

  it("returns empty results for zero limits and empty book", async () => {
    const { lotrade } = await loadFixture(deployFixture);

    const [emptyBuy, buyCount] = await lotrade.getBuyBook(0);
    const [emptySell, sellCount] = await lotrade.getSellBook(0);
    const [emptyBuyOrders, buyOrdersCount] = await lotrade.getBuyOrders(0);
    const [emptySellOrders, sellOrdersCount] = await lotrade.getSellOrders(0);
    expect(emptyBuy.length).to.equal(0);
    expect(emptySell.length).to.equal(0);
    expect(emptyBuyOrders.length).to.equal(0);
    expect(emptySellOrders.length).to.equal(0);
    expect(buyCount).to.equal(0n);
    expect(sellCount).to.equal(0n);
    expect(buyOrdersCount).to.equal(0n);
    expect(sellOrdersCount).to.equal(0n);

    const [buyBook, buyBookCount] = await lotrade.getBuyBook(5);
    const [sellBook, sellBookCount] = await lotrade.getSellBook(5);
    expect(buyBook.length).to.equal(0);
    expect(sellBook.length).to.equal(0);
    expect(buyBookCount).to.equal(0n);
    expect(sellBookCount).to.equal(0n);
  });

  it("exposes book levels, FIFO orders, top-of-book, and oracle views", async () => {
    const { lotrade, wetc, strn10k, alice, bob, carol } =
      await loadFixture(deployFixture);

    const buyTick1 = 2;
    const buyTick2 = 0;
    const sellTick1 = 3;
    const sellTick2 = 5;

    const priceBuy1 = await lotrade.priceAtTick(buyTick1);
    const priceBuy2 = await lotrade.priceAtTick(buyTick2);
    await wetc.connect(alice).approve(lotrade, priceBuy1 * 3n);
    await wetc.connect(bob).approve(lotrade, priceBuy2 * 2n);
    const buyId1 = await lotrade.connect(alice)["placeBuy(int256,uint256)"].staticCall(buyTick1, 3n);
    await lotrade.connect(alice)["placeBuy(int256,uint256)"](buyTick1, 3n);
    const buyId2 = await lotrade.connect(bob)["placeBuy(int256,uint256)"].staticCall(buyTick2, 2n);
    await lotrade.connect(bob)["placeBuy(int256,uint256)"](buyTick2, 2n);

    await strn10k.connect(alice).approve(lotrade, 4n);
    await strn10k.connect(bob).approve(lotrade, 3n);
    const sellId1 = await lotrade.connect(alice)["placeSell(int256,uint256)"].staticCall(sellTick1, 4n);
    await lotrade.connect(alice)["placeSell(int256,uint256)"](sellTick1, 4n);
    const sellId2 = await lotrade.connect(bob)["placeSell(int256,uint256)"].staticCall(sellTick2, 3n);
    await lotrade.connect(bob)["placeSell(int256,uint256)"](sellTick2, 3n);

    const [buyBook, buyCount] = await lotrade.getBuyBook(10);
    const [sellBook, sellCount] = await lotrade.getSellBook(10);
    expect(buyCount).to.equal(2n);
    expect(sellCount).to.equal(2n);
    expect(buyBook[0].tick).to.equal(buyTick1);
    expect(buyBook[1].tick).to.equal(buyTick2);
    expect(sellBook[0].tick).to.equal(sellTick1);
    expect(sellBook[1].tick).to.equal(sellTick2);

    expect(buyBook[0].totalLots).to.equal(3n);
    expect(buyBook[0].totalValue).to.equal(priceBuy1 * 3n);
    expect(buyBook[1].totalLots).to.equal(2n);
    expect(buyBook[1].totalValue).to.equal(priceBuy2 * 2n);

    const [buyOrders, buyOrdersCount] = await lotrade.getBuyOrders(10);
    expect(buyOrdersCount).to.equal(2n);
    expect(buyOrders[0].id).to.equal(buyId1);
    expect(buyOrders[1].id).to.equal(buyId2);

    const [sellOrders, sellOrdersCount] = await lotrade.getSellOrders(10);
    expect(sellOrdersCount).to.equal(2n);
    expect(sellOrders[0].id).to.equal(sellId1);
    expect(sellOrders[1].id).to.equal(sellId2);

    const [bestBuy, buyLots, buyOrdersTop, bestSell, sellLots, sellOrdersTop] =
      await lotrade.getTopOfBook();
    expect(bestBuy).to.equal(buyTick1);
    expect(buyLots).to.equal(3n);
    expect(buyOrdersTop).to.equal(1n);
    expect(bestSell).to.equal(sellTick1);
    expect(sellLots).to.equal(4n);
    expect(sellOrdersTop).to.equal(1n);

    const priceSell1 = await lotrade.priceAtTick(sellTick1);
    await wetc.connect(carol).approve(lotrade, priceSell1 * 2n);
    await lotrade.connect(carol)["buyFOK(int256,uint256,uint256)"](sellTick1, 2n, priceSell1 * 2n);

    const [obBestBuy, obBestSell, lastTick, lastBlock, lastPrice] =
      await lotrade.getOracle();
    expect(obBestBuy).to.equal(await lotrade.bestBuyTick());
    expect(obBestSell).to.equal(await lotrade.bestSellTick());
    expect(lastTick).to.equal(sellTick1);
    expect(lastPrice).to.equal(priceSell1);
    expect(lastBlock).to.be.greaterThan(0n);
  });

});

describe("Gas metrics", function () {
  const GAS_PRICE = ethers.parseUnits("1", "gwei");
  const GAS_OVERRIDES = { type: 0, gasPrice: GAS_PRICE };

  async function gasUsedFor(txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    return receipt.gasUsed;
  }

  function logGas(label, gasUsed) {
    const costWei = gasUsed * GAS_PRICE;
    const costGwei = ethers.formatUnits(costWei, "gwei");
    console.log(`${label}: gasUsed=${gasUsed} cost=${costGwei} gwei`);
  }

  it("logs maker gas for placeBuy and placeSell", async () => {
    const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);

    const buyTick = 0;
    const sellTick = 1;
    const lots = 1n;

    const buyPrice = await lotrade.priceAtTick(buyTick);
    const buyCost = buyPrice * lots;
    await wetc.connect(alice).approve(lotrade, buyCost * 2n);
    await lotrade.connect(alice)["placeBuy(int256,uint256)"](buyTick, lots, GAS_OVERRIDES);
    const gasPlaceBuy = await gasUsedFor(
      lotrade.connect(alice)["placeBuy(int256,uint256)"](buyTick, lots, GAS_OVERRIDES)
    );
    logGas("placeBuy (1 lot, warmed)", gasPlaceBuy);

    await strn10k.connect(bob).approve(lotrade, lots * 2n);
    await lotrade.connect(bob)["placeSell(int256,uint256)"](sellTick, lots, GAS_OVERRIDES);
    const gasPlaceSell = await gasUsedFor(
      lotrade.connect(bob)["placeSell(int256,uint256)"](sellTick, lots, GAS_OVERRIDES)
    );
    logGas("placeSell (1 lot, warmed)", gasPlaceSell);

    expect(gasPlaceBuy).to.be.greaterThan(0n);
    expect(gasPlaceSell).to.be.greaterThan(0n);
  });

  it("logs taker gas for buyFOK single vs 200 orders (single tick + 200 ticks)", async () => {
    {
      const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const tick = 0;
      const lots = 1n;

      await strn10k.connect(alice).approve(lotrade, lots);
      await lotrade.connect(alice)["placeSell(int256,uint256)"](tick, lots);

      const price = await lotrade.priceAtTick(tick);
      const maxWetcIn = price * lots;
      await wetc.connect(bob).approve(lotrade, maxWetcIn);
      const gasUsed = await gasUsedFor(
        lotrade.connect(bob)["buyFOK(int256,uint256,uint256)"](tick, lots, maxWetcIn, GAS_OVERRIDES)
      );
      logGas("buyFOK single order", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const tick = 0;
      const lotsPerOrder = 1n;
      const price = await lotrade.priceAtTick(tick);
      const maxWetcIn = price * BigInt(orders);

      await strn10k.connect(alice).approve(lotrade, BigInt(orders));
      for (let i = 0; i < orders; i++) {
        await lotrade.connect(alice)["placeSell(int256,uint256)"](tick, lotsPerOrder);
      }

      await wetc.connect(bob).approve(lotrade, maxWetcIn);
      const gasUsed = await gasUsedFor(
        lotrade
          .connect(bob)
          ["buyFOK(int256,uint256,uint256)"](tick, BigInt(orders), maxWetcIn, GAS_OVERRIDES)
      );
      logGas("buyFOK 200 orders single tick", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const lotsPerOrder = 1n;
      let maxWetcIn = 0n;

      await strn10k.connect(alice).approve(lotrade, BigInt(orders));
      for (let i = 0; i < orders; i++) {
        const tick = i;
        await lotrade.connect(alice)["placeSell(int256,uint256)"](tick, lotsPerOrder);
        const price = await lotrade.priceAtTick(tick);
        maxWetcIn += price * lotsPerOrder;
      }

      await wetc.connect(bob).approve(lotrade, maxWetcIn);
      const gasUsed = await gasUsedFor(
        lotrade
          .connect(bob)
          ["buyFOK(int256,uint256,uint256)"](orders - 1, BigInt(orders), maxWetcIn, GAS_OVERRIDES)
      );
      logGas("buyFOK 200 orders across 200 ticks", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }
  });

  it("logs taker gas for sellFOK single vs 200 orders (single tick + 200 ticks)", async () => {
    {
      const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const tick = 0;
      const lots = 1n;

      const price = await lotrade.priceAtTick(tick);
      await wetc.connect(alice).approve(lotrade, price * lots);
      await lotrade.connect(alice)["placeBuy(int256,uint256)"](tick, lots);

      await strn10k.connect(bob).approve(lotrade, lots);
      const gasUsed = await gasUsedFor(
        lotrade.connect(bob)["sellFOK(int256,uint256,uint256)"](tick, lots, price * lots, GAS_OVERRIDES)
      );
      logGas("sellFOK single order", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const tick = 0;
      const lotsPerOrder = 1n;
      const price = await lotrade.priceAtTick(tick);
      const minWetcOut = price * BigInt(orders);

      await wetc.connect(alice).approve(lotrade, minWetcOut);
      for (let i = 0; i < orders; i++) {
        await lotrade.connect(alice)["placeBuy(int256,uint256)"](tick, lotsPerOrder);
      }

      await strn10k.connect(bob).approve(lotrade, BigInt(orders));
      const gasUsed = await gasUsedFor(
        lotrade
          .connect(bob)
          ["sellFOK(int256,uint256,uint256)"](tick, BigInt(orders), minWetcOut, GAS_OVERRIDES)
      );
      logGas("sellFOK 200 orders single tick", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }

    {
      const { lotrade, wetc, strn10k, alice, bob } = await loadFixture(deployFixture);
      const orders = 200;
      const lotsPerOrder = 1n;
      let minWetcOut = 0n;

      for (let i = 0; i < orders; i++) {
        const tick = i;
        const price = await lotrade.priceAtTick(tick);
        minWetcOut += price * lotsPerOrder;
      }

      await wetc.connect(alice).approve(lotrade, minWetcOut);
      for (let i = 0; i < orders; i++) {
        const tick = i;
        await lotrade.connect(alice)["placeBuy(int256,uint256)"](tick, lotsPerOrder);
      }

      await strn10k.connect(bob).approve(lotrade, BigInt(orders));
      const gasUsed = await gasUsedFor(
        lotrade
          .connect(bob)
          ["sellFOK(int256,uint256,uint256)"](0, BigInt(orders), minWetcOut, GAS_OVERRIDES)
      );
      logGas("sellFOK 200 orders across 200 ticks", gasUsed);
      expect(gasUsed).to.be.greaterThan(0n);
    }
  });
});

describe("Token contracts", function () {
  it("TestERC20 transfers and allowances behave as expected", async () => {
    const [owner, alice] = await ethers.getSigners();
    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const token = await TestERC20.deploy("Test", "TST", 18, 1000n);

    await expect(token.transfer(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await expect(
      token.connect(alice).transfer(owner.address, 1n)
    ).to.be.revertedWith("balance");

    await expect(token.approve(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero spender"
    );

    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 1n)
    ).to.be.revertedWith("allowance");

    await expect(token.approve(alice.address, 200n))
      .to.emit(token, "Approval")
      .withArgs(owner.address, alice.address, 200n);

    await expect(token.transfer(alice.address, 300n))
      .to.emit(token, "Transfer")
      .withArgs(owner.address, alice.address, 300n);
    expect(await token.balanceOf(alice.address)).to.equal(300n);

    await token.connect(alice).transferFrom(owner.address, alice.address, 100n);
    expect(await token.allowance(owner.address, alice.address)).to.equal(100n);

    await token.approve(alice.address, 500n);
    await token.transfer(alice.address, 590n);
    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 200n)
    ).to.be.revertedWith("balance");
  });

  it("TestERC20 mint guard reverts for zero address", async () => {
    const [owner] = await ethers.getSigners();
    const TestERC20Harness = await ethers.getContractFactory("TestERC20Harness");
    const token = await TestERC20Harness.deploy("Test", "TST", 18, 1n);

    await expect(token.mintTo(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await token.mintTo(owner.address, 1n);
    expect(await token.totalSupply()).to.equal(2n);
  });

  it("ReentrantERC20 supports transfer hooks and bubbles failures", async () => {
    const [owner, alice] = await ethers.getSigners();
    const ReentrantERC20 = await ethers.getContractFactory("ReentrantERC20");
    const ReentryTarget = await ethers.getContractFactory("ReentryTarget");
    const token = await ReentrantERC20.deploy("Re", "RE", 18, 1000n);
    const target = await ReentryTarget.deploy();

    await expect(token.approve(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero spender"
    );

    await expect(
      token.connect(alice).transfer(owner.address, 1n)
    ).to.be.revertedWith("balance");
    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 1n)
    ).to.be.revertedWith("allowance");
    await expect(token.transfer(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );

    await token.transfer(alice.address, 1n);
    expect(await target.calls()).to.equal(0n);

    await token.setReentry(await target.getAddress(), "0x", false, false);
    await token.transfer(alice.address, 1n);
    expect(await target.calls()).to.equal(0n);

    const pingData = target.interface.encodeFunctionData("ping");
    await token.setReentry(await target.getAddress(), pingData, true, false);
    await token.transfer(alice.address, 1n);
    expect(await target.calls()).to.equal(1n);

    await token.approve(alice.address, 10n);
    await token.setReentry(await target.getAddress(), pingData, false, false);
    await token.connect(alice).transferFrom(owner.address, alice.address, 1n);
    expect(await target.calls()).to.equal(1n);

    await token.setReentry(await target.getAddress(), pingData, false, true);
    await token.connect(alice).transferFrom(owner.address, alice.address, 1n);
    expect(await target.calls()).to.equal(2n);

    const boomData = target.interface.encodeFunctionData("boom");
    await token.setReentry(await target.getAddress(), boomData, true, false);
    await expect(token.transfer(alice.address, 1n)).to.be.revertedWith("boom");

    const silentData = target.interface.encodeFunctionData("silentBoom");
    await token.setReentry(await target.getAddress(), silentData, true, false);
    await expect(token.transfer(alice.address, 1n)).to.be.revertedWith(
      "reentry failed"
    );
  });

  it("ReentrantERC20 guards transfers and mint inputs", async () => {
    const [owner, alice] = await ethers.getSigners();
    const ReentrantERC20Harness = await ethers.getContractFactory(
      "ReentrantERC20Harness"
    );
    const token = await ReentrantERC20Harness.deploy("Re", "RE", 18, 1000n);

    await expect(token.transfer(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await expect(
      token.connect(alice).transfer(owner.address, 1n)
    ).to.be.revertedWith("balance");
    await expect(
      token.connect(alice).transferFrom(owner.address, alice.address, 1n)
    ).to.be.revertedWith("allowance");

    await expect(token.mintTo(ethers.ZeroAddress, 1n)).to.be.revertedWith(
      "zero to"
    );
    await token.mintTo(owner.address, 1n);
    expect(await token.totalSupply()).to.equal(1001n);
  });
});
