/*
    AI used here. Provided raw data from gamma api and provided scope of task to provide usable types
    MODE: GPT-5.6 SOL
*/

type GammaMarket = {
  id: string;
  question: string;
  // stringified in raw res. need to parse during usage
  outcomes: string;
  // stringified in raw res. need to parse during usage
  clobTokenIds: string;
};

export type GammaEvent = {
  id: string;
  slug: string;
  title: string;
  markets: GammaMarket[];
  startTime: string;
  endDate: string;
};

export type FlashDirection = "up" | "down";

export type PriceFlash = {
  direction: FlashDirection;
  sequence: number;
};

export type MarketFlashes = {
  bid: PriceFlash | null;
  ask: PriceFlash | null;
  lastTrade: PriceFlash | null;
  spread: PriceFlash | null;
};

export type MarketPrice = {
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  tickSize: string | null;
  flashes: MarketFlashes;
};

/**
 * asks: [{price: "0.99", size: "702"}, {price: "0.96", size: "600"}, {price: "0.93", size: "402"},…]
asset_id: "6402659898402586525967099483820737583371405943661812272798416205811742427566"
bids: [{price: "0.01", size: "1407"}, {price: "0.04", size: "600"}, {price: "0.07", size: "402"},…]
event_type: "book"
hash: "9b90710fcba9ebe0803c84c04eaeffdbdd1e9cc5"
last_trade_price: "0.320"
market: "0xa88c9eaa65d5ae8d70187a6e6391324317e9b911e3708225fe822d6ddc586e5f"
tick_size: "0.01"
timestamp: "1791737529583"
 */
type BookMarketMessage = {
  event_type: "book";
  asset_id: string;
  bids: Array<{
    price: string;
    size: string;
  }>;
  asks: Array<{
    price: string;
    size: string;
  }>;
  last_trade_price: string;
  market: string;
  tick_size: string;
  timestamp: string;
};

/**
 * {
    "market": "0x9a4f4a4fe30246e311ceef0c3f8775409dd98c094c5e80379bb5fb2a71764fef",
    "price_changes": [
        {
            "asset_id": "5084938823202325350427960091607464079260825626266148441507361559457360919697",
            "price": "0.01",
            "size": "41899",
            "side": "BUY",
            "hash": "07c9924a28e8ec361c22c07bad8cc3b6278d055c",
            "best_bid": "0.74",
            "best_ask": "0.76"
        },
        {
            "asset_id": "31936526814920769301803756716468375028376398224269965854896457027934694532288",
            "price": "0.99",
            "size": "41899",
            "side": "SELL",
            "hash": "babaaa69c851ab87dcb2ffcde9198b0fe1602b7c",
            "best_bid": "0.24",
            "best_ask": "0.26"
        }
    ],
    "timestamp": "1791740639142",
    "event_type": "price_change"
}
 */
type PriceChangeMarketMessage = {
  event_type: "price_change";
  market: string;
  price_changes: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: "BUY" | "SELL";
    hash: string;
    best_bid: string;
    best_ask: string;
  }>;
  timestamp: string;
};

/**
 * {
    "market": "0xb9670c0f9acaad197eb9da0cfbf0b8d1e7f4e223ea02b7eaaba590ef60144020",
    "asset_id": "111424662242962426340697565522721971528319447344032882343204808936650778611132",
    "price": "0.51",
    "size": "10",
    "fee_rate_bps": "0",
    "side": "SELL",
    "timestamp": "1791741038729",
    "event_type": "last_trade_price",
    "transaction_hash": "0x81cf222d38a50a7405738bd0eac635b80847f5d9a85cca5d412f834c972caf09"
}
 */
type LastTradeMarketMessage = {
  event_type: "last_trade_price";
  market: string;
  asset_id: string;
  price: string;
  size: string;
  fee_rate_bps: string;
  side: "BUY" | "SELL";
  timestamp: string;
  transaction_hash: string;
};

type TickSizeChangeMarketMessage = {
  event_type: "tick_size_change";
  market: string;
  asset_id: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: string;
};

// Union type of all the ws messages
export type MarketMessage =
  | BookMarketMessage
  | PriceChangeMarketMessage
  | LastTradeMarketMessage
  | TickSizeChangeMarketMessage;
