import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";
import { getMarketsForGame, useGetNflGames } from "./utils/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  MarketMessage,
  MarketPrice,
  PriceFlash,
} from "./types/gamma-api";

const queryClient = new QueryClient();
const EMPTY_PRICES: MarketPrice = {
  bid: null,
  ask: null,
  lastTrade: null,
  tickSize: null,
  flashes: {
    bid: null,
    ask: null,
    lastTrade: null,
    spread: null,
  },
};

function getSpread(bid: number | null, ask: number | null) {
  return bid !== null && ask !== null ? ask - bid : null;
}

function getNextFlash(
  previousValue: number | null,
  nextValue: number | null,
  currentFlash: PriceFlash | null,
): PriceFlash | null {
  if (
    previousValue === null ||
    nextValue === null ||
    previousValue === nextValue
  ) {
    return currentFlash;
  }

  return {
    direction: nextValue > previousValue ? "up" : "down",
    sequence: (currentFlash?.sequence ?? 0) + 1,
  };
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <NFLMarketDashboard />
    </QueryClientProvider>
  );
}

function NFLMarketDashboard() {
  const [selectedGameId, setSelectedGameId] = useState<string>("");
  const [socketState, setSocketState] = useState<string>("disconnected");
  const [pricesPerMarket, setPricesPerMarket] = useState(
    () => new Map<string, MarketPrice>(),
  );
  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const subscribedIdsRef = useRef<string[]>([]);
  const desiredIdsRef = useRef<string[]>([]);
  const activeAssetIdsRef = useRef(new Set<string>());
  const intentionallyClosedRef = useRef(false);

  const { data: games, isLoading, error } = useGetNflGames();

  const selectedGame = games?.find((g) => g.id === selectedGameId) ?? null;

  const markets = useMemo(
    () => (selectedGame ? getMarketsForGame(selectedGame) : []),
    [selectedGame],
  );

  const moneylines = useMemo(() => {
    return markets.filter((m) => m.type === "moneyline");
  }, [markets]);

  const totals = useMemo(() => {
    return markets.filter((m) => m.type === "total");
  }, [markets]);

  const subscriptionIds = useMemo(
    () => markets.map((market) => market.clobTokenId),
    [markets],
  );

  const handleMessage = useCallback((msg: MarketMessage) => {
    if (msg.event_type === "book") {
      if (!activeAssetIdsRef.current.has(msg.asset_id)) return;

      setPricesPerMarket((prev) => {
        const existing = prev.get(msg.asset_id);
        const bid =
          msg.bids.length > 0
            ? Math.max(...msg.bids.map((b) => Number(b.price)))
            : null;
        const ask =
          msg.asks.length > 0
            ? Math.min(...msg.asks.map((a) => Number(a.price)))
            : null;
        const lastTrade = msg.last_trade_price
          ? Number(msg.last_trade_price)
          : (existing?.lastTrade ?? null);

        if (
          existing &&
          existing.bid === bid &&
          existing.ask === ask &&
          existing.lastTrade === lastTrade &&
          existing.tickSize === msg.tick_size
        ) {
          return prev;
        }

        const next = new Map(prev);
        next.set(msg.asset_id, {
          bid,
          ask,
          lastTrade,
          tickSize: msg.tick_size,
          flashes: existing?.flashes ?? EMPTY_PRICES.flashes,
        });

        return next;
      });
    } else if (msg.event_type === "price_change") {
      const activePriceChanges = msg.price_changes.filter((change) =>
        activeAssetIdsRef.current.has(change.asset_id),
      );

      if (activePriceChanges.length === 0) return;

      setPricesPerMarket((prev) => {
        let next: Map<string, MarketPrice> | null = null;

        for (const change of activePriceChanges) {
          const existing =
            (next ?? prev).get(change.asset_id) ?? EMPTY_PRICES;
          const bid = change.best_bid
            ? Number(change.best_bid)
            : existing.bid;
          const ask = change.best_ask
            ? Number(change.best_ask)
            : existing.ask;

          if (existing.bid === bid && existing.ask === ask) continue;

          const previousSpread = getSpread(existing.bid, existing.ask);
          const nextSpread = getSpread(bid, ask);
          const flashes = {
            ...existing.flashes,
            bid: getNextFlash(existing.bid, bid, existing.flashes.bid),
            ask: getNextFlash(existing.ask, ask, existing.flashes.ask),
            spread: getNextFlash(
              previousSpread,
              nextSpread,
              existing.flashes.spread,
            ),
          };

          if (!next) next = new Map(prev);

          next.set(change.asset_id, {
            bid,
            ask,
            lastTrade: existing.lastTrade,
            tickSize: existing.tickSize,
            flashes,
          });
        }

        return next ?? prev;
      });

      return;
    } else if (msg.event_type === "last_trade_price") {
      if (!activeAssetIdsRef.current.has(msg.asset_id)) return;

      setPricesPerMarket((prev) => {
        const existing = prev.get(msg.asset_id) ?? EMPTY_PRICES;
        const lastTrade = Number(msg.price);

        if (existing.lastTrade === lastTrade) return prev;

        const next = new Map(prev);

        next.set(msg.asset_id, {
          ...existing,
          lastTrade,
          flashes: {
            ...existing.flashes,
            lastTrade: getNextFlash(
              existing.lastTrade,
              lastTrade,
              existing.flashes.lastTrade,
            ),
          },
        });

        return next;
      });
    } else if (msg.event_type === "tick_size_change") {
      if (!activeAssetIdsRef.current.has(msg.asset_id)) return;

      setPricesPerMarket((prev) => {
        const existing = prev.get(msg.asset_id) ?? EMPTY_PRICES;

        if (existing.tickSize === msg.new_tick_size) return prev;

        const next = new Map(prev);
        next.set(msg.asset_id, {
          ...existing,
          tickSize: msg.new_tick_size,
        });

        return next;
      });
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const replaceSubscriptions = useCallback(
    (nextIds: string[], initial = false) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      const previousIds = subscribedIdsRef.current;
      const unchanged =
        previousIds.length === nextIds.length &&
        previousIds.every((id, index) => id === nextIds[index]);

      if (unchanged) return;

      if (previousIds.length > 0) {
        socket.send(
          JSON.stringify({
            operation: "unsubscribe",
            assets_ids: previousIds,
          }),
        );
      }

      if (nextIds.length > 0) {
        socket.send(
          JSON.stringify(
            initial || previousIds.length === 0
              ? {
                  assets_ids: nextIds,
                  type: "market",
                  initial_dump: true,
                }
              : {
                  operation: "subscribe",
                  assets_ids: nextIds,
                },
          ),
        );
      }

      subscribedIdsRef.current = [...nextIds];
    },
    [],
  );

  const connect = useCallback(() => {
    if (
      socketRef.current?.readyState === WebSocket.CONNECTING ||
      socketRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    const socket = new WebSocket(
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    );
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;

      setSocketState("connected");
      subscribedIdsRef.current = [];
      replaceSubscriptions(desiredIdsRef.current, true);

      clearHeartbeat();
      heartbeatRef.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send("PING");
      }, 10_000);
    };

    socket.onmessage = (evt) => {
      if (socketRef.current !== socket || evt.data === "PONG") return;

      const data = JSON.parse(evt.data);
      const messages = Array.isArray(data) ? data : [data];

      for (const msg of messages) {
        handleMessage(msg);
      }
    };

    socket.onclose = () => {
      if (socketRef.current !== socket) return;

      socketRef.current = null;
      subscribedIdsRef.current = [];
      clearHeartbeat();
      setSocketState("disconnected");

      if (!intentionallyClosedRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, 2_000);
      }
    };

    socket.onerror = () => socket.close();
  }, [clearHeartbeat, handleMessage, replaceSubscriptions]);

  useEffect(() => {
    intentionallyClosedRef.current = false;
    connect();

    return () => {
      intentionallyClosedRef.current = true;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      clearHeartbeat();
      subscribedIdsRef.current = [];
      activeAssetIdsRef.current = new Set();

      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
      setSocketState("disconnected");
    };
  }, [clearHeartbeat, connect]);

  useEffect(() => {
    desiredIdsRef.current = subscriptionIds;
    activeAssetIdsRef.current = new Set(subscriptionIds);
    setPricesPerMarket(new Map());
    replaceSubscriptions(subscriptionIds);
  }, [replaceSubscriptions, subscriptionIds]);

  if (isLoading)
    return <main className="status-page">Loading all NFL games...</main>;
  if (error)
    return (
      <main className="status-page">
        Error fetching NFL games: {error.message}
      </main>
    );

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Polymarket · NFL</p>
          <h1>Live Market Dashboard</h1>
          <p>Moneyline and full-game totals in one live view.</p>
        </div>
        <span className={`connection-status ${socketState}`}>
          <span />
          {socketState === "connected" ? "Live" : "Disconnected"}
        </span>
      </header>

      <section className="game-picker">
        <label htmlFor="game-selection">Game</label>
        <select
          id="game-selection"
          value={selectedGameId}
          onChange={(e) => setSelectedGameId(e.target.value)}
        >
          <option value="" disabled>
            Select an NFL game
          </option>
          {games?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title} · {new Date(g.startTime).toLocaleString()}
            </option>
          ))}
        </select>
      </section>

      {!selectedGameId ? (
        <section className="empty-state">
          <h2>Select a game</h2>
          <p>Choose a matchup above to view its live markets.</p>
        </section>
      ) : (
        <section className="market-panel">
          <header className="game-heading">
            <div>
              <h2>{selectedGame?.title}</h2>
              <p>{new Date(selectedGame!.startTime).toLocaleString()}</p>
            </div>
            <span>{markets.length} outcomes</span>
          </header>

          {markets.length === 0 ? (
            <p className="table-empty">No markets found for this game.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Outcome</th>
                    <th scope="col">Best bid</th>
                    <th scope="col">Best ask</th>
                    <th scope="col">Last trade</th>
                    <th scope="col">Spread</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="market-group-row">
                    <th colSpan={5} scope="rowgroup">
                      Game outcome · Moneyline
                    </th>
                  </tr>
                  {!(moneylines.length === 0) &&
                    moneylines.map((m) => (
                      <MarketRow
                        key={m.clobTokenId}
                        market={m}
                        prices={pricesPerMarket.get(m.clobTokenId)}
                      />
                    ))}

                  <tr className="market-group-row">
                    <th colSpan={5} scope="rowgroup">
                      Full-game totals · {totals.length / 2} lines
                    </th>
                  </tr>
                  {!(totals.length === 0) &&
                    totals.map((t) => (
                      <MarketRow
                        key={t.clobTokenId}
                        market={t}
                        prices={pricesPerMarket.get(t.clobTokenId)}
                      />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

const MarketRow = memo(function MarketRow({
  market,
  prices,
}: {
  market: ReturnType<typeof getMarketsForGame>[number];
  prices?: MarketPrice;
}) {
  const bid = prices?.bid ?? null;
  const ask = prices?.ask ?? null;
  const lastTrade = prices?.lastTrade ?? null;
  const tickSize = prices?.tickSize ?? null;
  const spread = getSpread(bid, ask);

  return (
    <tr className="market-row">
      <th scope="row">
        <strong>{market.outcome}</strong>
        <small>{market.question}</small>
      </th>
      <PriceCell
        className="bid"
        flash={prices?.flashes.bid ?? null}
        label="Best bid"
        tickSize={tickSize}
        value={bid}
      />
      <PriceCell
        className="ask"
        flash={prices?.flashes.ask ?? null}
        label="Best ask"
        tickSize={tickSize}
        value={ask}
      />
      <PriceCell
        flash={prices?.flashes.lastTrade ?? null}
        label="Last trade"
        tickSize={tickSize}
        value={lastTrade}
      />
      <PriceCell
        flash={prices?.flashes.spread ?? null}
        label="Spread"
        tickSize={tickSize}
        value={spread}
      />
    </tr>
  );
});

function PriceCell({
  className = "",
  flash,
  label,
  tickSize,
  value,
}: {
  className?: string;
  flash: PriceFlash | null;
  label: string;
  tickSize: string | null;
  value: number | null;
}) {
  const flashClass = flash ? `flash-${flash.direction}` : "";

  return (
    <td
      key={`${label}-${flash?.sequence ?? 0}`}
      className={`price-cell ${className} ${flashClass}`.trim()}
      data-label={label}
    >
      {formatPrice(value, tickSize)}
    </td>
  );
}

function getTickDecimals(tickSize: string | null) {
  if (!tickSize || !tickSize.includes(".")) return 0;
  return tickSize.split(".")[1].length;
}

function formatPrice(price: number | null, tickSize: string | null) {
  if (price === null || Number.isNaN(price)) return "—";

  if (!tickSize) return price.toFixed(3);

  const numericTick = Number(tickSize);
  if (!Number.isFinite(numericTick) || numericTick <= 0) {
    return price.toFixed(3);
  }

  const rounded =
    Math.round((price + Number.EPSILON) / numericTick) * numericTick;

  return rounded.toFixed(getTickDecimals(tickSize));
}

export default App;
