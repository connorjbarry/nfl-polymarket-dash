import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { getMarketsForGame, useGetNflGames } from "./utils/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MarketMessage, MarketPrice } from "./types/gamma-api";

const queryClient = new QueryClient();

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

  const EMPTY_PRICES = {
    bid: null,
    ask: null,
    lastTrade: null,
  };

  const handleMessage = (msg: MarketMessage) => {
    if (msg.event_type === "book") {
      setPricesPerMarket((prev) => {
        const next = new Map(prev);

        const existing = pricesPerMarket.get(msg.asset_id);
        next.set(msg.asset_id, {
          bid: Math.max(...msg.bids.map((b) => Number(b.price)), 0),
          ask: Math.min(...msg.asks.map((a) => Number(a.price)), 0),
          lastTrade: msg.last_trade_price
            ? Number(msg.last_trade_price)
            : (existing?.lastTrade ?? null),
        });

        return next;
      });
    } else if (msg.event_type === "price_change") {
      for (const change of msg.price_changes) {
        setPricesPerMarket((prev) => {
          const next = new Map(prev);

          const existing = pricesPerMarket.get(change.asset_id) ?? EMPTY_PRICES;

          next.set(change.asset_id, {
            bid: change.best_bid ? Number(change.best_bid) : existing.bid,
            ask: change.best_ask ? Number(change.best_ask) : existing.ask,
            lastTrade: existing.lastTrade,
          });

          return next;
        });
      }
    } else if (msg.event_type === "last_trade_price") {
      setPricesPerMarket((prev) => {
        const next = new Map(prev);
        const existing = pricesPerMarket.get(msg.asset_id) ?? EMPTY_PRICES;

        next.set(msg.asset_id, {
          ...existing,
          lastTrade: Number(msg.price),
        });

        return next;
      });
      // } else if (msg.event_type === "tick_size_change") {
    }
  };

  // socket logic
  useEffect(() => {
    // if no markets, dont try to connect to ws with no subscription id
    if (markets.length === 0) return;

    let stopped = false;
    let socket: WebSocket;
    let heartbeat: ReturnType<typeof setInterval>;
    const subscriptionIds = markets.map((m) => m.clobTokenId);

    const connect = () => {
      socket = new WebSocket(
        "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      );

      socket.onopen = () => {
        setSocketState("connected");

        socket.send(
          JSON.stringify({
            assets_ids: subscriptionIds,
            type: "market",
            initial_dump: true,
          }),
        );

        heartbeat = setInterval(() => socket.send("PING"), 10_000);
      };

      socket.onmessage = (evt) => {
        // dont do anything if message is for keep-alive purposes or ws is stopped
        if (stopped || evt.data === "PONG") return;

        const data = JSON.parse(evt.data);
        const messages = Array.isArray(data) ? data : [data];

        for (const msg of messages) {
          handleMessage(msg);
        }
      };

      socket.onclose = () => {
        setSocketState("disconnected");
        if (stopped) return;
        clearInterval(heartbeat);
      };
    };

    connect();

    return () => {
      stopped = true;
      socket.close();
      clearInterval(heartbeat);
      setSocketState("disconnected");
    };
  }, [selectedGameId]);

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

function MarketRow({
  market,
  prices,
}: {
  market: ReturnType<typeof getMarketsForGame>[number];
  prices?: MarketPrice;
}) {
  const bid = prices?.bid ?? null;
  const ask = prices?.ask ?? null;
  const lastTrade = prices?.lastTrade ?? null;
  const spread = bid !== null && ask !== null ? ask - bid : null;

  return (
    <tr className="market-row">
      <th scope="row">
        <strong>{market.outcome}</strong>
        <small>{market.question}</small>
      </th>
      <td className="bid" data-label="Best bid">{formatPrice(bid)}</td>
      <td className="ask" data-label="Best ask">{formatPrice(ask)}</td>
      <td data-label="Last trade">{formatPrice(lastTrade)}</td>
      <td data-label="Spread">{formatPrice(spread)}</td>
    </tr>
  );
}

function formatPrice(price: number | null) {
  return price === null || Number.isNaN(price) ? "—" : price.toFixed(3);
}


export default App;
