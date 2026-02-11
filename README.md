# Saturn Lot Trading EVM Contract - TEST VERSION

```
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
  SaturnLotTrade v0.6.3 (Design / Testnet)
  By PseudoDeterminist
  See README at https://github.com/PseudoDeterminist/saturn-lot-trade for details.
*/
```

This contract deployment on ETC is for TEST only. I'm reasonably certain if you put tokens in, you can get them out again safely. It is NOT designed for real trading at this time, and I have not and shall not trade on it. I just liked the idea of deploying on ETC for my own development purposes.

This project demonstrates a basic Lot Trading token pair, intended for the Ethereum Classic blockchain. It's especially suited for ETC because it's meant to trade at the speed of proof of work: Slowly but at high value.

In most tests this contract uses generic mock tokens. On ETC mainnet it is configured _for testing_ with WETC (price quote) and STRN10K (base lot token).

STRN10K represents a 10,000-token Lot, meant to be a wrapper for the underlying asset at 10K STRN to exactly 1 (no decimals) STRN10K.

WETC is the wrapped ETC quote asset used on ETC mainnet. In other tests, a mock WETC is deployed.

## UI network toggle

The UI supports a query parameter to switch between local Hardhat and ETC mainnet: 

- Hardhat (default): open `ui/index.html`
- ETC mainnet: open `ui/index.html?net=etc` (uses your local ETC node at `http://127.0.0.1:8545`)

Demo mode is now opt-in:

- Demo data: open `ui/index.html?demo=1` (or `ui/index.html?net=etc&demo=1`)

## Deploy checklist (ETC mainnet)

- Confirm token addresses in `.env`: `MAINNET_WETC_ADDRESS`, `MAINNET_STRN10K_ADDRESS`.
- Confirm RPC and deployer: `MAINNET_RPC_URL`, `MAINNET_DEPLOYER_PK`.
- Deploy: `npx hardhat run --network etc scripts/deploy-etc.cjs`.
- Verify: `npx hardhat verify --network etc <DEPLOYED_ADDRESS> <WETC_ADDRESS> <STRN10K_ADDRESS>`.
- Record the verified Blockscout link after verification completes.

## Deployment links

- ETC mainnet TEST SaturnLotTrade: https://etc.blockscout.com/address/0x989445dA165F787Bb07B9C04946D87BbF9051EEf#code
- Mordor testnet SaturnLotTrade: https://etc-mordor.blockscout.com/address/0xf4B146FbA71F41E0592668ffbF264F1D186b2Ca8#code

## Token addresses (ETC mainnet)

These tokens will accept original SATURN tokens and convert them to 1-1 same units (STRN) or 10,000-1 Lots (STRN10K) and back again. I'm reasonably certain if you put tokens in them, you can get them out again, but again these are for TESTING ONLY and I am done with them, and have left all balances ZERO at time of writing. That's by design. IGNORE tokens that are not supported by their original DAO. Or test away, that's all I have done.

- STRN: `0xeEd7A7fB8659663C7be8EF6985e38c62cB616Ca6`
- STRN10K: `0x7d35D3938c3b4446473a4ac29351Bd93694b5DEF`
- WETC: `0x82A618305706B14e7bcf2592D4B9324A366b6dAd`

This contract is NOT for small trades! It's designed to do high-value Lot Trading only. As such, its design is intended to entirely eliminate dust from trading, and to never waste block space on small trades that are perhaps best done on Layer 2 platforms.

It is this author's belief that on-chain orderbook trading may never be the "right" way to trade; but if it can be, this contract is trying to implement one kind of model that could succeed.

Trading is by its nature aggressive and adversarial. We don't want to eliminate these qualities from Layer 1, but if they're to be played out at high value on expensive proof-of-work blocks that are 15 seconds apart, then some important tradeoffs must be made. This contract represents one possible way to do it.

Prices available for traders to set in this contract are spaced out along an exponential price curve, here plotted as assets/PriceCurve.png, using the python program at tools/PriceTicks.py, which was used to create the curve for solidity.

Why exponential? So that movements up or down this curve will always represent a nearly constant percentage (approximately 1/2 %) of the current price.

![Price tick curve showing exponential price distribution from 1000 to 99500](tools/assets/PriceCurve.png)

The above curve is only a visual aid for users to see that the solidity number blocks that represent prices do actually generate an approximately smooth curve. The priceTicks were plotted using matlab in Python.

In Python, the priceTicks, in decimal form, look like this:
```
1000  1005  1010  1015  1020  1025 . . . 9707  9755  9803  9852  9901  9950
```
These numbers represent wei prices from 1000 wei up to 9950 wei. After 9950 the numbers are appended at ten times their previous value, so the whole list is repeated as
```
10000 10050 10100 10150 10200 10250 . . . 97070 97550 98030 98520 99010 99500
```
And the whole list would then be repeated again at 100000, ten times higher and so on.

The curve shown is just two generations of the price ticks, to show visually that they do smoothly join together.

For the Solidity contract SaturnLotTrade.sol, the price ticks are consolidated in a hexadecimal block for efficient blockchain use:

```bytes internal constant MANT =
        hex"03e803ed03f203f703fc04010406040b04100416041b04200425042b04300435"
        hex"043b04400445044b04500456045b04610466046c04720477047d04830489048e"
        hex"0494049a04a004a604ac04b204b804be04c404ca04d004d604dc04e204e804ef"
          .
          .
          .
        hex"241524432471249f24ce24fd252c255b258b25bb25eb261b264b267c26ad26de"

```

But they just represent the curve and decimal prices generated by our Python tool.

Traders who use this contract, set prices that may only match the decimal prices at the tick marks, which are always nearly 0.5 percent apart.

So if you were trading at 1000 wei (which no one would, but the curve does start there), and you wanted to raise the price, you would go to the next price tick, 1050 wei. That raises the price approximately 1/2 percent from the tick you were on.

By the time you are at 9950 your next price tick will be 10000 and you continue smoothly up from there into (hopefully) eventually reasonable prices!

If your price is, say, 0.1015 ETC for a Lot of 10K STRN, then the integer price on chain is 101500000000000000 wei, derived from this curve. Your next lower price is .1010 ETC and your next higher price is .1020 ETC.

The ticks are designed to have only four significant decimal digits at all scales. 

This aids both in human readability and in eliminating dust-level "precision" in trying to fit prices exactly to the curve. We sacrifice that exactness for these benefits, and yet the curve still looks smooth at scale, as the plot shows.

Traders don't get into petty price-difference wars between ticks, because those prices are unavailable by design. This means if a trader wants to set the new "best trade" they must be willing to lower the best price or raise the highest bid by a full half percent!

For this particular trading pair, TEST price range has been set so that lowest cost 10K Lot is .1 ETC, and highest cost is somewhere beyond reasonable. Lowest cost at .1 ETC is intended to disable use of this style of contract for easily spammed low values. If the real price is lower this is not an appropriate venue for trading the asset.

