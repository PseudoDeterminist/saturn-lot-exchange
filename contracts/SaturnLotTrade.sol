// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
  SaturnLotTrade v0.6.3 (Design / Testnet)
  By PseudoDeterminist
  See README at https://github.com/PseudoDeterminist/saturn-lot-trade for details.
*/

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/* ===================== Lot CLOB ===================== */

contract SaturnLotTrade {
    using SafeERC20 for IERC20;
    // Tick range: -464 .. +1855 (5 decades * 464 ticks/decade)
    int32 private constant MIN_TICK = -464; // 0.1 WETC per lot; 0.00001 WETC per STRN
    int32 private constant MAX_TICK = 1855; // 9950 WETC per lot; 0.995 WETC per STRN
    uint32 private constant MAX_LOTS = 100000;

    int32 private constant NONE32 = type(int32).min;
    int256 private constant NONE256 = int256(NONE32);

    IERC20 public immutable WETC;    // quote token (18 decimals)
    IERC20 public immutable STRN10K;  // base token (0 decimals, integer lots)

    uint256 private constant ETC_MAINNET_CHAIN_ID = 61;
    address private constant ETC_MAINNET_WETC = 0x82A618305706B14e7bcf2592D4B9324A366b6dAd;
    address private constant ETC_MAINNET_STRN10K = 0x7d35D3938c3b4446473a4ac29351Bd93694b5DEF;

    // Event integrity chain (increments once per emitted event)
    uint64 public historySeq;
    bytes32 public historyHash;

    // Oracle
    int256 public lastTradeTick;
    uint256 public lastTradePrice;
    uint256 public lastTradeBlock;
    int256 public bestBuyTick;
    int256 public bestSellTick;

    // Running escrow totals (resting maker escrows)
    uint256 public bookEscrowWETC;     // total WETC Escrowed in buy orders
    uint256 public bookEscrowSTRN10K;   // total STRN10K Escrowed in sell orders
    uint256 public bookAskSTRN10K;      // total STRN10K asked in buy orders
    uint256 public bookAskWETC;        // total WETC asked in sell orders

    /* -------------------- Events -------------------- */

    // Event type tags used in hash records
    uint8 private constant EVT_PLACE  = 1;
    uint8 private constant EVT_CANCEL = 2;
    uint8 private constant EVT_TRADE  = 3;

    event OrderPlaced(
        uint64 indexed seq,
        bytes32 indexed newHash,
        uint64 indexed orderId,
        address owner,
        bool isBuy,
        int32 tick,
        uint32 lots,                   // if isBuy: STRN10K Ask placed; else STRN10K Escrowed
        uint128 value                  // if isBuy: WETC Escrowed; else WETC Ask placed
    );

    event OrderCanceled(
        uint64 indexed seq,
        bytes32 indexed newHash,
        uint64 indexed orderId,
        address owner,
        bool isBuy,
        int32 tick,
        uint32 lotsCanceled,           // if isBuy: STRN10K Ask canceled; else STRN10K Escrow refunded
        uint128 valueCanceled          // if isBuy: WETC Escrow refunded; else WETC Ask canceled
    );

    // One Trade event per maker fill (FOK taker may generate multiple)
    event Trade(
        uint64 indexed seq,
        bytes32 indexed newHash,
        uint64 indexed orderId,
        address taker,
        address maker,
        bool takerIsBuy,
        int32 tick,
        uint96 pricePerLot,
        uint32 lotsFilled,
        uint128 valueFilled,
        uint32 lotsRemainingAfter,      // if maker.isBuy: STRN10K Ask remaining; else STRN10K Escrow remaining
        uint128 valueRemainingAfter     // if maker.isBuy: WETC Escrow remaining; else WETC Ask remaining
    );

    /* -------------------- Order book data -------------------- */

    struct Order {
        address owner;
        int32 tick;
        uint32 lotsRemaining;           // if isBuy: STRN10K Ask remaining; else STRN10K Escrow remaining
        bool isBuy;
        uint128 valueRemaining;         // if isBuy: WETC Escrow remaining; else WETC Ask remaining
        uint64 prev;
        uint64 next;
    }

    struct TickLevel {
        uint96 price;
        int32 prev;
        int32 next;
        uint32 orderCount;
        uint64 head;
        uint64 tail;
        uint64 totalLots;               // if buyLevel: STRN10K Ask total; else STRN10K Escrow total
        uint128 totalValue;             // if buyLevel: WETC Escrow total; else WETC Ask total
    }

    uint64 public nextOrderId = 1;

    mapping(uint64 => Order) public orders;
    mapping(int256 => TickLevel) public buyLevels;
    mapping(int256 => TickLevel) public sellLevels;

    // Book return structs
    struct BookLevel {
        int256 tick;
        uint256 price;
        uint256 totalLots;               // if buyLevel: STRN10K Ask total; else STRN10K Escrow total
        uint256 totalValue;              // if buyLevel: WETC Escrow total; else WETC Ask total
        uint256 orderCount;
    }

    struct BookOrder {
        uint256 id;
        address owner;
        int256 tick;
        uint256 price;
        uint256 lotsRemaining;
        uint256 valueRemaining;
    }

    // Packed mantissa bytes (464 uint16, big-endian, 2 bytes each)
    bytes internal constant MANT =
        hex"03e803ed03f203f703fc04010406040b04100416041b04200425042b04300435"
        hex"043b04400445044b04500456045b04610466046c04720477047d04830489048e"
        hex"0494049a04a004a604ac04b204b804be04c404ca04d004d604dc04e204e804ef"
        hex"04f504fb05020508050e0515051b05220528052f0536053c0543054a05500557"
        hex"055e0565056c0572057905800587058e0595059d05a405ab05b205b905c105c8"
        hex"05cf05d705de05e605ed05f505fc0604060c0613061b0623062b0632063a0642"
        hex"064a0652065a0662066b0673067b0683068b0694069c06a506ad06b606be06c7"
        hex"06cf06d806e106e906f206fb0704070d0716071f07280731073a0744074d0756"
        hex"075f07690772077c0785078f079807a207ac07b607bf07c907d307dd07e707f1"
        hex"07fb08060810081a0824082f08390844084e08590863086e08790884088e0899"
        hex"08a408af08ba08c508d108dc08e708f208fe090909150920092c09380943094f"
        hex"095b09670973097f098b099709a309b009bc09c809d509e109ee09fb0a070a14"
        hex"0a210a2e0a3b0a480a550a620a6f0a7d0a8a0a970aa50ab20ac00ace0adb0ae9"
        hex"0af70b050b130b210b2f0b3e0b4c0b5a0b690b770b860b950ba30bb20bc10bd0"
        hex"0bdf0bee0bfe0c0d0c1c0c2c0c3b0c4b0c5a0c6a0c7a0c8a0c9a0caa0cba0cca"
        hex"0cda0ceb0cfb0d0c0d1c0d2d0d3e0d4f0d600d710d820d930da40db60dc70dd9"
        hex"0dea0dfc0e0e0e200e320e440e560e680e7b0e8d0e9f0eb20ec50ed80eeb0efe"
        hex"0f110f240f370f4a0f5e0f720f850f990fad0fc10fd50fe90ffd10121026103b"
        hex"104f10641079108e10a310b810ce10e310f8110e1124113a11501166117c1192"
        hex"11a811bf11d511ec1203121a12311248125f1277128e12a612be12d612ee1306"
        hex"131e1336134f13671380139913b213cb13e413fd14171430144a1464147e1498"
        hex"14b214cd14e71502151d15371552156e158915a415c015dc15f716131630164c"
        hex"1668168516a116be16db16f8171617331750176e178c17aa17c817e618051823"
        hex"184218611880189f18bf18de18fe191e193e195e197e199f19bf19e01a011a22"
        hex"1a431a651a861aa81aca1aec1b0f1b311b541b761b991bbd1be01c031c271c4b"
        hex"1c6f1c931cb81cdc1d011d261d4b1d701d961dbb1de11e071e2e1e541e7b1ea1"
        hex"1ec81ef01f171f3f1f661f8e1fb71fdf200820302059208320ac20d620ff2129"
        hex"2154217e21a921d421ff222a2256228122ad22d923062332235f238c23b923e7"
        hex"241524432471249f24ce24fd252c255b258b25bb25eb261b264b267c26ad26de";

    constructor(address wetcToken, address strn10kToken) {
        if (block.chainid == ETC_MAINNET_CHAIN_ID) {
            WETC = IERC20(ETC_MAINNET_WETC);
            STRN10K = IERC20(ETC_MAINNET_STRN10K);
        } else {
            require(wetcToken != address(0), "zero WETC");
            require(strn10kToken != address(0), "zero STRN10K");
            WETC = IERC20(wetcToken);
            STRN10K = IERC20(strn10kToken);
        }
        bestBuyTick = NONE256;
        bestSellTick = NONE256;
    }

    /* -------------------- Price -------------------- */

    function priceAtTick(int256 tick) public pure returns (uint256 result) {
        require(tick >= MIN_TICK && tick <= MAX_TICK, "tick out of range");

        uint256 t = uint256(tick - MIN_TICK); // safe because of require above
        uint256 d = t / 464;                  // decade index (0..4)
        uint256 r = t % 464;                  // mantissa index (0..463)

        uint256 i = r * 2;
        uint256 m = (uint256(uint8(MANT[i])) << 8) | uint256(uint8(MANT[i + 1]));

        uint256 factor;
        if (d == 0) factor = 1e14;       //    0.1 to      0.995 WETC per lot = 0.00001 to  0.0000995 WETC per Base STRN
        else if (d == 1) factor = 1e15;  //      1 to      9.95  WETC per lot = 0.0001  to  0.000995  WETC per Base STRN
        else if (d == 2) factor = 1e16;  //     10 to     99.5   WETC per lot = 0.001   to  0.00995   WETC per Base STRN
        else if (d == 3) factor = 1e17;  //    100 to    995     WETC per lot = 0.01    to  0.0995    WETC per Base STRN
        else factor = 1e18;              //   1000 to   9950     WETC per lot = 0.1     to  0.995     WETC per Base STRN

        result = factor * m;
    }

    function _toTick(int256 tick) internal pure returns (int32) {
        require(tick >= MIN_TICK && tick <= MAX_TICK, "tick out of range");
        return int32(tick);
    }

    /* -------------------- Hash chain helpers -------------------- */

    function _chainHash(bytes32 chain, bytes32 recordHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(chain, recordHash));
    }

    function _emitPlaced(
        uint64 seq,
        bytes32 chain,
        uint64 orderId,
        address owner,
        bool isBuy,
        int32 tick,
        uint32 lots,
        uint128 value
    ) internal returns (uint64, bytes32) {
        unchecked {
            ++seq;
        }
        bytes32 rec = keccak256(
            abi.encode(EVT_PLACE, seq, orderId, owner, isBuy, tick, lots, value)
        );
        bytes32 newHash = _chainHash(chain, rec);
        emit OrderPlaced(seq, newHash, orderId, owner, isBuy, tick, lots, value);
        return (seq, newHash);
    }

    function _emitCanceled(
        uint64 seq,
        bytes32 chain,
        uint64 orderId,
        address owner,
        bool isBuy,
        int32 tick,
        uint32 lotsCanceled,
        uint128 valueCanceled
    ) internal returns (uint64, bytes32) {
        unchecked {
            ++seq;
        }
        bytes32 rec = keccak256(
            abi.encode(EVT_CANCEL, seq, orderId, owner, isBuy, tick, lotsCanceled, valueCanceled)
        );
        bytes32 newHash = _chainHash(chain, rec);
        emit OrderCanceled(seq, newHash, orderId, owner, isBuy, tick, lotsCanceled, valueCanceled);
        return (seq, newHash);
    }

    function _emitTrade(
        uint64 seq,
        bytes32 chain,
        uint64 orderId,
        address taker,
        address maker,
        bool takerIsBuy,
        int32 tick,
        uint96 pricePerLot,
        uint32 lotsFilled,
        uint128 valueFilled,
        uint32 lotsRemainingAfter,
        uint128 valueRemainingAfter
    ) internal returns (uint64, bytes32) {
        unchecked {
            ++seq;
        }
        bytes32 rec = keccak256(
            abi.encode(
                EVT_TRADE,
                seq,
                orderId,
                taker,
                maker,
                takerIsBuy,
                tick,
                pricePerLot,
                lotsFilled,
                valueFilled,
                lotsRemainingAfter,
                valueRemainingAfter
            )
        );
        bytes32 newHash = _chainHash(chain, rec);
        emit Trade(
            seq,
            newHash,
            orderId,
            taker,
            maker,
            takerIsBuy,
            tick,
            pricePerLot,
            lotsFilled,
            valueFilled,
            lotsRemainingAfter,
            valueRemainingAfter
        );
        return (seq, newHash);
    }

    /* -------------------- Maker Orders (escrow on placement) -------------------- */

    function placeBuy(int256 tick, uint256 lots) public returns (uint64 id) {
        require(lots > 0 && lots <= MAX_LOTS, "invalid lots");
        int32 t = _toTick(tick);
        require(bestSellTick == NONE256 || bestSellTick > int256(t), "crossing sell book -- consider buyFOK");

        uint64 seq = historySeq;
        bytes32 chain = historyHash;

        uint32 lots32 = uint32(lots);
        uint96 price = uint96(priceAtTick(tick));
        uint256 cost = uint256(lots32) * uint256(price);

        // Escrow WETC in this contract
        WETC.safeTransferFrom(msg.sender, address(this), cost); // reverts on insufficient balance/allowance

        id = _newOrder(true, t, lots32, uint128(cost));
        _enqueue(true, t, price, lots32, uint128(cost), id);

        // Track buy escrow (global)
        bookEscrowWETC += cost;
        bookAskSTRN10K += lots32;

        (seq, chain) = _emitPlaced(seq, chain, id, msg.sender, true, t, lots32, uint128(cost));
        historySeq = seq;
        historyHash = chain;
    }

    function placeBuy(int256 tick, uint256 lots, bytes32 expectedHash) external returns (uint64 id) {
        require(historyHash == expectedHash, "stale hash");
        return placeBuy(tick, lots);
    }

    function placeSell(int256 tick, uint256 lots) public returns (uint64 id) {
        require(lots > 0 && lots <= MAX_LOTS, "invalid lots");
        int32 t = _toTick(tick);
        require(bestBuyTick == NONE256 || bestBuyTick < int256(t), "crossing buy book -- consider sellFOK");

        uint64 seq = historySeq;
        bytes32 chain = historyHash;

        // Escrow STRN10K lots in this contract
        uint32 lots32 = uint32(lots);
        STRN10K.safeTransferFrom(msg.sender, address(this), uint256(lots32));  // reverts on insufficient balance/allowance

        uint96 price = uint96(priceAtTick(tick));
        uint256 value = uint256(lots32) * uint256(price);

        id = _newOrder(false, t, lots32, uint128(value));
        _enqueue(false, t, price, lots32, uint128(value), id);

        // Track sell escrow (global). Per-level is already totalLots.
        bookEscrowSTRN10K += lots32;
        bookAskWETC += value;

        (seq, chain) = _emitPlaced(seq, chain, id, msg.sender, false, t, lots32, uint128(value));
        historySeq = seq;
        historyHash = chain;
    }

    function placeSell(int256 tick, uint256 lots, bytes32 expectedHash) external returns (uint64 id) {
        require(historyHash == expectedHash, "stale hash");
        return placeSell(tick, lots);
    }

    function cancel(uint64 id) external {
        Order storage o = orders[id];
        require(o.owner == msg.sender, "not order owner");

        uint64 seq = historySeq;
        bytes32 chain = historyHash;

        uint32 lotsRemaining = o.lotsRemaining;
        uint128 valueRemaining = o.valueRemaining;
        bool isBuy = o.isBuy;
        int32 tick = o.tick;

        _unlinkOrder(isBuy, tick, id);
        (seq, chain) = _emitCanceled(seq, chain, id, msg.sender, isBuy, tick, lotsRemaining, valueRemaining);
        historySeq = seq;
        historyHash = chain;

        delete orders[id];

        // Refund remaining escrow
        if (isBuy) {
            bookEscrowWETC -= valueRemaining;
            bookAskSTRN10K -= lotsRemaining;

            WETC.safeTransfer(msg.sender, uint256(valueRemaining));   // only after state updates
        } else {
            bookAskWETC -= valueRemaining;
            bookEscrowSTRN10K -= lotsRemaining;

            STRN10K.safeTransfer(msg.sender, uint256(lotsRemaining));   // only after state updates
        }
    }

    /* -------------------- Taker FOK -------------------- */

    function buyFOK(int256 limitTick, uint256 lots, uint256 maxWetcIn) public {
        require(lots > 0, "You requested zero lots");
        require(bestSellTick != NONE256, "There are no sell orders on book");
        require(lots <= bookEscrowSTRN10K, "insufficient escrowed STRN10K on book");

        WETC.safeTransferFrom(msg.sender, address(this), maxWetcIn); // escrow maxWetcIn. reverts on insufficient balance/allowance

        uint64 seq = historySeq;
        bytes32 chain = historyHash;

        uint256 remain = lots;
        uint256 spent = 0;
        uint96 price;
        uint256 bookEscrowStrn10k = bookEscrowSTRN10K;
        uint256 bookAskWetc = bookAskWETC;

        int256 t = bestSellTick;

        while (remain > 0) {
            require(t <= limitTick, "FOK--Limit tick crossed");
            TickLevel storage lvl = sellLevels[t];

            price = lvl.price;    // At this point either a trade happens at price or we advance and assign again

            uint64 head = lvl.head;

            while (remain > 0) {
                uint64 oid = head;
                if (oid == 0) break;

                Order storage m = orders[oid];
                address maker = m.owner;
                uint32 mLots = m.lotsRemaining;
                uint32 fill = remain < mLots ? uint32(remain) : mLots;
                mLots -= fill;

                uint256 pay = uint256(fill) * uint256(price);

                // Slippage guard: total quote spent cannot exceed maxWetcIn
                spent += pay;
                require(spent <= maxWetcIn, "FOK--Slippage exceeded");

                // Update balances
                uint128 remainingValue;
                if (mLots == 0) {
                    head = m.next;
                    unchecked {
                        lvl.orderCount--;
                    }
                    delete orders[oid];
                    if (head == 0) {
                        lvl.tail = 0;
                    }
                    remainingValue = 0;
                } else {
                    remainingValue = m.valueRemaining - uint128(pay);
                    m.lotsRemaining = mLots;
                    m.valueRemaining = remainingValue;
                }

                lvl.totalLots -= fill;
                lvl.totalValue -= uint128(pay);
                bookEscrowStrn10k -= fill;
                bookAskWetc -= pay;

                remain -= fill;

                // Contract delivers WETC to maker (seller) after state updates
                WETC.safeTransfer(maker, pay);

                // Taker receipts are consolidated and paid after all fills

                (seq, chain) = _emitTrade(
                    seq,
                    chain,
                    oid,
                    msg.sender,
                    maker,
                    true,
                    int32(t),
                    price,
                    fill,
                    uint128(pay),
                    mLots,
                    remainingValue
                );
            }

            if (head == 0) {
                int32 nxt = lvl.next;
                _removeTick(false, int32(t));
                if (remain == 0) break;
                if (nxt == NONE32) break;
                t = int256(nxt);
            } else {
                if (head != lvl.head) {
                    lvl.head = head;
                    orders[head].prev = 0;
                }
            }
        }

        require(remain == 0, "FOK--Unfilled");

        bookEscrowSTRN10K = bookEscrowStrn10k;
        bookAskWETC = bookAskWetc;

        historySeq = seq;
        historyHash = chain;

        lastTradeBlock = block.number;
        lastTradeTick = t;
        lastTradePrice = price;

        // Pay taker their STRN10K receipts after all fills
        STRN10K.safeTransfer(msg.sender, lots);

        // Refund any unspent WETC to taker
        if (spent < maxWetcIn) {
            WETC.safeTransfer(msg.sender, maxWetcIn - spent);
        }
    }

    function buyFOK(int256 limitTick, uint256 lots, uint256 maxWetcIn, bytes32 expectedHash) external {
        require(historyHash == expectedHash, "stale hash");
        buyFOK(limitTick, lots, maxWetcIn);
    }

    function sellFOK(int256 limitTick, uint256 lots, uint256 minWetcOut) public {
        require(lots > 0, "You requested zero lots");
        require(bestBuyTick != NONE256, "There are no buy orders on book");
        require(lots <= bookAskSTRN10K, "FOK--Insufficient asked STRN10K on book");
        require(minWetcOut <= bookEscrowWETC, "FOK--Insufficient escrowed WETC on book");

        STRN10K.safeTransferFrom(msg.sender, address(this), lots); // escrow STRN10K. reverts on insufficient balance/allowance

        uint64 seq = historySeq;
        bytes32 chain = historyHash;

        uint256 remain = lots;
        uint256 got = 0;
        uint96 price;
        uint256 bookAskStrn10k = bookAskSTRN10K;
        uint256 bookEscrowWetc = bookEscrowWETC;

        int256 t = bestBuyTick;

        while (remain > 0) {
            require(t >= limitTick, "FOK--Limit tick crossed");
            TickLevel storage lvl = buyLevels[t];

            price = lvl.price;    // At this point either a trade happens at price or we revert on FOK

            uint64 head = lvl.head;

            while (remain > 0) {
                uint64 oid = head;
                if (oid == 0) break;

                Order storage m = orders[oid];
                address maker = m.owner;
                uint32 mLots = m.lotsRemaining;
                uint32 fill = remain < mLots ? uint32(remain) : mLots;
                mLots -= fill;

                uint256 receiveAmt = uint256(fill) * uint256(price);
                got += receiveAmt;

                // Update balances
                uint128 remainingValue;
                if (mLots == 0) {
                    head = m.next;
                    unchecked {
                        lvl.orderCount--;
                    }
                    delete orders[oid];
                    if (head == 0) {
                        lvl.tail = 0;
                    }
                    remainingValue = 0;
                } else {
                    remainingValue = m.valueRemaining - uint128(receiveAmt);
                    m.lotsRemaining = mLots;
                    m.valueRemaining = remainingValue;
                }

                lvl.totalLots -= fill;
                lvl.totalValue -= uint128(receiveAmt);
                bookAskStrn10k -= fill;
                bookEscrowWetc -= receiveAmt;

                remain -= fill;

                // Contract delivers STRN10K to maker (buyer) after state updates
                STRN10K.safeTransfer(maker, uint256(fill));

                // Taker receipts are consolidated and paid after all fills

                (seq, chain) = _emitTrade(
                    seq,
                    chain,
                    oid,
                    msg.sender,
                    maker,
                    false,
                    int32(t),
                    price,
                    fill,
                    uint128(receiveAmt),
                    mLots,
                    remainingValue
                );
            }

            if (head == 0) {
                int32 nxt = lvl.next;
                _removeTick(true, int32(t));
                if (remain == 0) break;
                if (nxt == NONE32) break;
                t = int256(nxt);
            } else {
                if (head != lvl.head) {
                    lvl.head = head;
                    orders[head].prev = 0;
                }
            }
        }

        require(remain == 0, "FOK--Unfilled");
        require(got >= minWetcOut, "FOK--Slippage exceeded");

        bookAskSTRN10K = bookAskStrn10k;
        bookEscrowWETC = bookEscrowWetc;

        historySeq = seq;
        historyHash = chain;

        lastTradeTick = t;
        lastTradePrice = price;
        lastTradeBlock = block.number;

        // Pay taker their WETC receipts after all fills
        WETC.safeTransfer(msg.sender, got);

    }

    function sellFOK(int256 limitTick, uint256 lots, uint256 minWetcOut, bytes32 expectedHash) external {
        require(historyHash == expectedHash, "stale hash");
        sellFOK(limitTick, lots, minWetcOut);
    }

    /* -------------------- Internals: Orders / Levels -------------------- */

    function _newOrder(bool isBuy, int32 tick, uint32 lots, uint128 value) internal returns (uint64 id) {
        id = nextOrderId++;
        orders[id] = Order(msg.sender, tick, lots, isBuy, value, 0, 0);
    }

    function _enqueue(bool isBuy, int32 tick, uint96 price, uint32 lots, uint128 value, uint64 id) internal {
        TickLevel storage lvl = isBuy ? buyLevels[tick] : sellLevels[tick];

        if (lvl.price == 0) {
            _insertTick(isBuy, tick, price);
        }

        if (lvl.tail == 0) {
            lvl.head = id;
            lvl.tail = id;
        } else {
            orders[lvl.tail].next = id;
            orders[id].prev = lvl.tail;
            lvl.tail = id;
        }

        unchecked {
            lvl.orderCount++;
        }
        lvl.totalValue += value;
        lvl.totalLots += lots;
    }

    function _insertTick(bool isBuy, int32 tick, uint96 price) internal {
        TickLevel storage lvl = isBuy ? buyLevels[tick] : sellLevels[tick];
        lvl.price = price;
        lvl.prev = NONE32;
        lvl.next = NONE32;

        if (isBuy) {
            if (bestBuyTick == NONE256) {
                bestBuyTick = int256(tick);
                return;
            }
            int256 cur = bestBuyTick;
            if (tick > cur) {
                lvl.next = int32(cur);
                buyLevels[cur].prev = tick;
                bestBuyTick = int256(tick);
                return;
            }
            while (true) {
                int32 nxt = buyLevels[cur].next;
                if (nxt == NONE32 || tick > nxt) {
                    lvl.prev = int32(cur);
                    lvl.next = nxt;
                    buyLevels[cur].next = tick;
                    if (nxt != NONE32) buyLevels[nxt].prev = tick;
                    return;
                }
                cur = nxt;
            }
        } else {
            if (bestSellTick == NONE256) {
                bestSellTick = int256(tick);
                return;
            }
            int256 cur = bestSellTick;
            if (tick < cur) {
                lvl.next = int32(cur);
                sellLevels[cur].prev = tick;
                bestSellTick = int256(tick);
                return;
            }
            while (true) {
                int32 nxt = sellLevels[cur].next;
                if (nxt == NONE32 || tick < nxt) {
                    lvl.prev = int32(cur);
                    lvl.next = nxt;
                    sellLevels[cur].next = tick;
                    if (nxt != NONE32) sellLevels[nxt].prev = tick;
                    return;
                }
                cur = nxt;
            }
        }
    }

    function _unlinkOrder(bool isBuy, int32 tick, uint64 id) internal {
        TickLevel storage lvl = isBuy ? buyLevels[tick] : sellLevels[tick];
        Order storage o = orders[id];

        if (o.prev == 0) lvl.head = o.next;
        else orders[o.prev].next = o.next;

        if (o.next == 0) lvl.tail = o.prev;
        else orders[o.next].prev = o.prev;

        unchecked {
            lvl.orderCount--;
        }
        lvl.totalLots -= o.lotsRemaining;
        lvl.totalValue -= o.valueRemaining;
        if (lvl.head == 0) _removeTick(isBuy, tick);
    }

    function _removeTick(bool isBuy, int32 tick) internal {
        TickLevel storage lvl = isBuy ? buyLevels[tick] : sellLevels[tick];
        int32 p = lvl.prev;
        int32 n = lvl.next;

        if (isBuy) {
            if (p == NONE32) bestBuyTick = int256(n);
            else buyLevels[p].next = n;
            if (n != NONE32) buyLevels[n].prev = p;
            delete buyLevels[tick];
        } else {
            if (p == NONE32) bestSellTick = int256(n);
            else sellLevels[p].next = n;
            if (n != NONE32) sellLevels[n].prev = p;
            delete sellLevels[tick];
        }
    }

    /* -------------------- Misc views -------------------- */

    function getBuyBook(uint256 maxLevels) external view returns (BookLevel[] memory out, uint256 n)
    {
        return getBook(true, maxLevels);
    }

    function getSellBook(uint256 maxLevels) external view returns (BookLevel[] memory out, uint256 n)
    {
        return getBook(false, maxLevels);
    }

    function getBuyOrders(uint256 maxOrders) external view returns (BookOrder[] memory out, uint256 n)
    {
        return getOrders(true, maxOrders);
    }

    function getSellOrders(uint256 maxOrders) external view returns (BookOrder[] memory out, uint256 n)
    {
        return getOrders(false, maxOrders);
    }

    function getBook(bool isBuy, uint256 maxLevels)
        internal
        view
        returns (BookLevel[] memory out, uint256 n)
    {
        if (maxLevels == 0) return (new BookLevel[](0), 0);

        if (isBuy) {
            if (bestBuyTick == NONE256) return (new BookLevel[](0), 0);
        } else {
            if (bestSellTick == NONE256) return (new BookLevel[](0), 0);
        }

        out = new BookLevel[](maxLevels);
        n = 0;

        if (isBuy) {
            int256 t = bestBuyTick;
            while (t != NONE256 && n < maxLevels) {
                TickLevel storage lvl = buyLevels[t];
                if (lvl.totalLots > 0) out[n++] = BookLevel(t, lvl.price,lvl.totalLots, lvl.totalValue, lvl.orderCount);
                t = lvl.next;
            }
        } else {
            int256 t = bestSellTick;
            while (t != NONE256 && n < maxLevels) {
                TickLevel storage lvl = sellLevels[t];
                if (lvl.totalLots > 0) out[n++] = BookLevel(t, lvl.price, lvl.totalLots, lvl.totalValue, lvl.orderCount);
                t = lvl.next;
            }
        }
    }

    function getOrders(bool isBuy, uint256 maxOrders)
        internal
        view
        returns (BookOrder[] memory out, uint256 n)
    {
        if (maxOrders == 0) return (new BookOrder[](0), 0);

        int256 t = isBuy ? bestBuyTick : bestSellTick;
        if (t == NONE256) return (new BookOrder[](0), 0);

        out = new BookOrder[](maxOrders);
        n = 0;

        while (t != NONE256 && n < maxOrders) {
            TickLevel storage lvl = isBuy ? buyLevels[t] : sellLevels[t];
            uint64 id = lvl.head;
            uint256 price = lvl.price;

            while (id != 0 && n < maxOrders) {
                Order storage o = orders[id];
                if (o.lotsRemaining > 0) {
                    out[n++] = BookOrder(id, o.owner, t, price, o.lotsRemaining, o.valueRemaining);
                }
                id = o.next;
            }

            t = lvl.next;
        }
    }

    function getTopOfBook() external view returns (
        int256, uint256, uint256,
        int256, uint256, uint256
    ) {
        uint256 buyLots;
        uint256 buyOrders;
        uint256 sellLots;
        uint256 sellOrders;

        if (bestBuyTick != NONE256) {
            TickLevel storage b = buyLevels[bestBuyTick];
            buyLots = b.totalLots;
            buyOrders = b.orderCount;
        }

        if (bestSellTick != NONE256) {
            TickLevel storage s = sellLevels[bestSellTick];
            sellLots = s.totalLots;
            sellOrders = s.orderCount;
        }

        return (bestBuyTick, buyLots, buyOrders, bestSellTick, sellLots, sellOrders);
    }

    function getOracle() external view returns (int256, int256, int256, uint256, uint256) {
        return (bestBuyTick, bestSellTick, lastTradeTick, lastTradeBlock, lastTradePrice);
    }

    function getEscrowTotals() external view returns (uint256 buyWETC, uint256 sellSTRN10K) {
        return (bookEscrowWETC, bookEscrowSTRN10K);
    }
}
