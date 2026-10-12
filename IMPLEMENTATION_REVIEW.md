# NFL Market Dashboard Implementation Review

## Requirement Status

| Area                           | Status      | Notes                                                                                           |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
| Offset pagination              | Implemented | Walks pages in increments of 100 until a short page is returned.                                |
| NFL game slug filter           | Implemented | Uses the required exact game-slug regular expression.                                           |
| Active game selection          | Implemented | Relies on the API's `active=true&closed=false` filters without an additional date cutoff.       |
| Moneyline selection            | Implemented | Requires exact equality with the event title.                                                   |
| Full-game totals selection     | Implemented | Requires the exact title prefix followed only by a numeric line.                                |
| Outcome/token pairing          | Implemented | Produces one row per outcome and associated CLOB token ID.                                      |
| Initial WebSocket subscription | Implemented | Sends every selected asset ID with `type: "market"` and `initial_dump: true`.                   |
| 10-second `PING`               | Implemented | Sends the required literal text frame.                                                          |
| Initial best bid/ask           | Implemented | Uses the highest bid and lowest ask; empty sides become `null`.                                 |
| Initial last trade             | Implemented | Seeds from `book.last_trade_price`.                                                             |
| `price_change` updates         | Implemented | Reads each item's `best_bid` and `best_ask` and batches the message into one state update.      |
| `last_trade_price` updates     | Implemented | Updates the asset's last-traded price while preserving its current quote.                       |
| Bid-ask spread                 | Implemented | Derives ask minus bid when both values are available.                                           |
| `tick_size_change`             | Missing     | No message type, state field, handler, or tick-aware formatting exists.                         |
| Same-socket event switching    | Missing     | Selection changes close the old socket and create a new one.                                    |
| Efficient row rendering        | Partial     | Updates are batched per message, but every update still rerenders the full dashboard and table. |
| 500 ms flash indicators        | Missing     | No direction tracking, timers, or visual flash states exist.                                    |

## Remaining Required Work

### High: tick-size handling is missing

The initial `book.tick_size` is declared in `src/types/gamma-api.ts:54`, but `src/App.tsx:48-68` does not store it. The `tick_size_change` branch remains commented out at `src/App.tsx:99`, and the event is absent from the `MarketMessage` union at `src/types/gamma-api.ts:125-129`.

Prices are always rendered with three decimal places at `src/App.tsx:299-300`. That does not guarantee correct rounding after the minimum tick changes.

Required changes:

- Add `tickSize` to the per-asset market state.
- Seed it from the initial `book.tick_size`.
- Add a `TickSizeChangeMarketMessage` type and include it in `MarketMessage`.
- Update the asset's tick size from each `tick_size_change` event.
- Round and format bid, ask, last trade, and spread using the current asset tick size.

### High: event switching reconnects instead of unsubscribing

The socket effect depends on `selectedGameId` at `src/App.tsx:159`. Its cleanup closes the connection at `src/App.tsx:155`, after which the next effect creates a new socket at `src/App.tsx:114`.

There is no persistent socket reference, no record of the currently subscribed IDs, and no message using:

```json
{ "operation": "unsubscribe", "assets_ids": ["<old_token_id>"] }
```

The connection and subscription lifecycles need to be separated:

1. Open the market WebSocket once.
2. Retain it in a ref.
3. Track the currently subscribed token IDs in another ref.
4. On game change, unsubscribe the old IDs.
5. Subscribe the new IDs on the existing open connection.
6. Close the socket only when the dashboard unmounts.

### High: full-table rerenders still occur

The implementation correctly batches all entries in one `price_change` message into a single `setPricesPerMarket` call at `src/App.tsx:70-84`.

However, `pricesPerMarket` still belongs to `NFLMarketDashboard`. Every new `Map` rerenders that component and every `MarketRow` at `src/App.tsx:237-258`. The rows are not memoized, so unchanged tokens rerender too.

To meet the explicit no-full-table-rerender requirement:

- Wrap `MarketRow` in `React.memo`.
- Ensure unchanged rows receive the same market and price object references.
- Update only price objects belonging to changed assets.
- For stronger isolation, use a token-keyed external store with per-token subscriptions through `useSyncExternalStore`.

### High: 500 ms price flashes are missing

The state stores only current bid, ask, and last trade values. It does not record whether a field increased or decreased, and the rendered cells have no transient flash class.

Each changed field needs to:

1. Compare its incoming value with its previous value.
2. Record `up` or `down` for that specific asset and field.
3. Apply a green or red cell class.
4. Remove or expire the class after 500 ms.

Only changed cells should flash; unchanged cells and rows should remain visually stable.

## Additional Issues and Risks

### Medium: repeated book snapshots are not guarded

Every `book` message is processed at `src/App.tsx:48-68`. The requirements only need the full snapshot once per asset. A delayed or repeated snapshot could replace values already updated by newer delta events.

Maintain a set of initialized asset IDs and ignore later `book` messages for assets that have already been seeded.

### Medium: old game prices remain in memory

Changing games does not clear entries from `pricesPerMarket`. Token IDs prevent those values from appearing in unrelated rows, but the map grows as the user selects more games.

When the active subscription changes, remove prices for the previous token IDs or replace the map with state for the new IDs.

### Medium: the NFL event list does not refresh

`useGetNflGames` has no refetch interval at `src/utils/utils.ts:56-62`. A long-running dashboard can retain games that subsequently close and will not discover newly opened events until a reload.

This is outside the market WebSocket itself, but a modest React Query refetch interval would keep event selection current.

### Medium: WebSocket effect dependencies are incomplete

The effect uses `markets` and `handleMessage`, but its dependency list contains only `selectedGameId`. The configured linter reports this issue at `src/App.tsx:111`.

This should be resolved by the persistent-connection subscription refactor. Simply adding the current `markets` array or `handleMessage` function would risk unnecessary effect restarts unless their identities are stabilized.

### Medium: unexpected socket closure does not reconnect

`socket.onclose` updates the status and clears the heartbeat, but does not attempt reconnection. A transient network failure leaves the dashboard permanently disconnected until the user switches games or reloads.

Automatic reconnect was not stated explicitly, but it is a notable reliability gap for a live dashboard.

### Low: incoming message parsing is unguarded

`JSON.parse` at `src/App.tsx:136` can throw on malformed or unexpected payloads. Message values are also trusted as `MarketMessage` without runtime event validation.

Wrap parsing in a safe boundary and verify `event_type` before processing.

### Low: event parsing lacks runtime validation

The Gamma API response is consumed as untyped JSON at `src/utils/utils.ts:38-44`. `parseStringArray` can also throw if a string field contains malformed JSON.

Runtime validation or guarded parsing would prevent one malformed event from failing the full event load.

## Confirmed Correct Behavior

- Pagination advances the offset by 100 and walks every page.
- The exact game-slug pattern excludes futures, props, period markets, and player sub-events.
- Duplicate event slugs are deduplicated.
- Games returned as active and open remain selectable after kickoff.
- Moneyline matching uses exact title equality.
- Total matching rejects team totals and quarter/half suffixes.
- Markets without exactly two outcomes and token IDs are excluded.
- Every selected outcome token is included in the initial subscription.
- The connection sends `PING` every 10 seconds.
- Initial snapshots correctly seed best bid, best ask, and last trade.
- Empty bid or ask sides render as unavailable rather than zero.
- `price_change` consumes the supplied best prices without rebuilding an order book.
- All changes in one `price_change` message are applied in one state update.
- `last_trade_price` preserves the latest bid and ask state.
- The table displays the market question and outcome label on one row per token.
- Spread is derived only when both best prices exist.

## Recommended Fix Order

1. Add tick-size state, message typing, updates, and formatting.
2. Establish one persistent socket and implement unsubscribe/subscribe switching.
3. Isolate rendering to changed token rows.
4. Add field-level 500 ms increase/decrease flashes.
5. Guard one-time snapshots and remove stale prices on event changes.
6. Add reconnection, event refetching, and safe payload parsing.

## Validation

- `pnpm build`: passes.
- `pnpm lint`: passes with one existing `react-hooks/exhaustive-deps` warning for the WebSocket effect.
