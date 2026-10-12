# NFL Market Dashboard Implementation Plan

## Goal

Finish every missing or partial item from `IMPLEMENTATION_REVIEW.md` without changing the existing event-selection rules, market-selection rules, table columns, or general UI layout.

The implementation should remain small and use the existing React, TypeScript, React Query, and browser WebSocket APIs. Do not add a state-management library or a schema-validation dependency.

## Files Expected to Change

| File | Purpose |
| --- | --- |
| `src/types/gamma-api.ts` | Add tick-size message typing and extend per-token state. |
| `src/App.tsx` | Handle all feed events, maintain one socket, switch subscriptions, optimize row rendering, and add flash metadata. |
| `src/App.css` | Add the 500 ms green/red cell animations. |
| `src/utils/utils.ts` | Add safe Gamma parsing and event-list refresh settings. |

Do not modify the slug regular expression, moneyline equality check, or full-game total matching rules.

## Target State Shape

### 1. Add flash types

Add these exported types to `src/types/gamma-api.ts`:

```ts
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
```

`sequence` exists so the same cell animation can restart when several changes move in the same direction. Every real change increments the sequence for that field.

### 2. Extend `MarketPrice`

Replace the current `MarketPrice` definition with:

```ts
export type MarketPrice = {
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  tickSize: string | null;
  flashes: MarketFlashes;
};
```

Store `tickSize` as a string. This preserves the exact number of decimal places from values such as `"0.01"` and `"0.001"`.

### 3. Add `tick_size_change` typing

Add this message type to `src/types/gamma-api.ts`:

```ts
type TickSizeChangeMarketMessage = {
  event_type: "tick_size_change";
  market: string;
  asset_id: string;
  old_tick_size: string;
  new_tick_size: string;
  timestamp: string;
};
```

Add it to the `MarketMessage` union.

### 4. Define one complete empty value

Move `EMPTY_PRICES` outside `NFLMarketDashboard` in `src/App.tsx` and type it as `MarketPrice`:

```ts
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
```

Never mutate `EMPTY_PRICES` or any object already stored in `pricesPerMarket`.

## Implementation Order

Implement the phases below in order. Run `pnpm build` and `pnpm lint` after every phase. Do not continue while TypeScript errors remain.

---

## Phase 1: Add Tick-Aware Price Formatting

### Files

- `src/types/gamma-api.ts`
- `src/App.tsx`

### Steps

1. Add the types and `MarketPrice` fields described in **Target State Shape**.
2. Update `EMPTY_PRICES` so every new field has a default.
3. In the `book` branch, set:

```ts
tickSize: msg.tick_size
```

4. Add a `tick_size_change` branch to `handleMessage`:

```ts
if (msg.event_type === "tick_size_change") {
  setPricesPerMarket((prev) => {
    const existing = prev.get(msg.asset_id) ?? EMPTY_PRICES;

    if (existing.tickSize === msg.new_tick_size) {
      return prev;
    }

    const next = new Map(prev);
    next.set(msg.asset_id, {
      ...existing,
      tickSize: msg.new_tick_size,
    });
    return next;
  });
}
```

5. Replace `formatPrice(price)` with `formatPrice(price, tickSize)`.
6. Implement formatting with these exact rules:

```ts
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

  const decimals = getTickDecimals(tickSize);
  const rounded =
    Math.round((price + Number.EPSILON) / numericTick) * numericTick;

  return rounded.toFixed(decimals);
}
```

7. Pass `prices?.tickSize ?? null` when formatting bid, ask, last trade, and spread.

### Acceptance Checks

- Tick `"0.1"` displays one decimal.
- Tick `"0.01"` displays two decimals.
- Tick `"0.001"` displays three decimals.
- `formatPrice(0.527, "0.01")` returns `"0.53"`.
- `formatPrice(0.5274, "0.001")` returns `"0.527"`.
- Missing prices still display `—`.
- A `tick_size_change` updates formatting without changing bid, ask, or last trade.

---

## Phase 2: Process Each Book Snapshot Only Once

### File

- `src/App.tsx`

### New ref

Add:

```ts
const initializedAssetIdsRef = useRef(new Set<string>());
```

Import `useRef` from React.

### Book-handler behavior

At the beginning of the `book` branch:

```ts
if (initializedAssetIdsRef.current.has(msg.asset_id)) {
  return;
}

initializedAssetIdsRef.current.add(msg.asset_id);
```

Only add the asset after confirming the message belongs to the currently selected subscription. Phase 3 adds that check.

### Reset rules

Clear or delete entries from this set when:

- Switching to a different game's token IDs.
- Reconnecting after the socket was disconnected, because the new connection will send new initial snapshots.
- Unmounting the dashboard.

### Acceptance Checks

- The first `book` for an active asset seeds its state.
- A second `book` for the same asset does not overwrite values received through later deltas.
- After reconnecting, one new snapshot for each current asset is accepted.

---

## Phase 3: Keep One WebSocket and Switch Subscriptions

### File

- `src/App.tsx`

### Imports

Add `useCallback` and `useRef` to the React import.

### Refs

Add these refs inside `NFLMarketDashboard`:

```ts
const socketRef = useRef<WebSocket | null>(null);
const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const subscribedIdsRef = useRef<string[]>([]);
const desiredIdsRef = useRef<string[]>([]);
const activeAssetIdsRef = useRef(new Set<string>());
const intentionallyClosedRef = useRef(false);
```

### Derive token IDs once

Add:

```ts
const subscriptionIds = useMemo(
  () => markets.map((market) => market.clobTokenId),
  [markets],
);
```

Do not recreate this list inside the connection effect.

### Create a subscription-switch helper

Define a `useCallback` named `replaceSubscriptions` with this behavior:

1. Read the current socket from `socketRef.current`.
2. Return immediately unless its `readyState` is `WebSocket.OPEN`.
3. Read old IDs from `subscribedIdsRef.current`.
4. Return if old IDs and new IDs contain the same values in the same order.
5. If old IDs exist, send:

```ts
socket.send(
  JSON.stringify({
    operation: "unsubscribe",
    assets_ids: oldIds,
  }),
);
```

6. If new IDs exist:
   - When `initial` is true **or** `oldIds.length === 0`, send:

```ts
socket.send(
  JSON.stringify({
    assets_ids: newIds,
    type: "market",
    initial_dump: true,
  }),
);
```

   - Otherwise, when replacing an existing subscription, send:

```ts
socket.send(
  JSON.stringify({
    operation: "subscribe",
    assets_ids: newIds,
  }),
);
```

7. Replace `subscribedIdsRef.current` with a copied array: `[...newIds]`.
8. Replace `activeAssetIdsRef.current` with `new Set(newIds)`.

### Connection effect

Replace the current `[selectedGameId]` socket effect with one connection effect whose dependency array is `[]` except for stable callbacks.

The connection effect must:

1. Set `intentionallyClosedRef.current = false`.
2. Create one `WebSocket` and save it in `socketRef.current`.
3. On open:
   - Set status to `"connected"`.
   - Reset `subscribedIdsRef.current` to `[]` because this is a fresh server connection.
   - Clear `initializedAssetIdsRef.current`.
   - Call `replaceSubscriptions(desiredIdsRef.current, true)` so the latest selection wins even if it changed while connecting.
   - Start exactly one 10-second `PING` interval.
4. On message:
   - Ignore `PONG`.
   - Parse safely as described in Phase 8.
   - Forward supported messages to `handleMessage`.
5. On close:
   - Clear the heartbeat.
   - Set status to `"disconnected"`.
   - Schedule reconnection unless `intentionallyClosedRef.current` is true.
6. On cleanup:
   - Set `intentionallyClosedRef.current = true`.
   - Clear heartbeat and reconnect timers.
   - Close the current socket.
   - Clear all subscription refs and snapshot guards.

### Selection/subscription effect

Create a second effect depending on `subscriptionIds` and `replaceSubscriptions`:

```ts
useEffect(() => {
  desiredIdsRef.current = subscriptionIds;

  initializedAssetIdsRef.current.clear();
  setPricesPerMarket(new Map());

  replaceSubscriptions(subscriptionIds, false);
}, [subscriptionIds, replaceSubscriptions]);
```

`replaceSubscriptions` must safely do nothing while the socket is still connecting. The connection's `onopen` handler will use `desiredIdsRef.current` later.

### Ignore stale messages

Before processing an asset message, confirm its asset ID is in `activeAssetIdsRef.current`.

- For `book`, `last_trade_price`, and `tick_size_change`, return if `msg.asset_id` is inactive.
- For `price_change`, filter `msg.price_changes` to active asset IDs before updating state.
- If no active price changes remain, return the previous map unchanged.

This prevents messages already in transit from the prior game from repopulating cleared state.

### Acceptance Checks

- Selecting the first game opens one socket and sends the initial subscription payload.
- Switching games does not create another WebSocket connection.
- Switching sends one unsubscribe frame containing all old IDs.
- Switching then sends one subscribe frame containing all new IDs.
- The 10-second heartbeat continues across game changes.
- Old game prices disappear immediately when switching.
- Late messages from the old game are ignored.
- Unmounting closes the socket and clears timers.

---

## Phase 4: Add Reconnection

### File

- `src/App.tsx`

### Behavior

Use a small fixed retry delay of 2 seconds. Do not implement exponential backoff for this assignment.

1. Put socket creation in a stable `connect` callback.
2. In `onclose`, if closure was not intentional:

```ts
reconnectTimerRef.current = setTimeout(connect, 2_000);
```

3. Before reconnecting, clear any existing reconnect timer.
4. When the new socket opens:
   - Treat it as a fresh connection.
   - Clear old subscribed IDs.
   - Clear initialized snapshot IDs.
   - Send the initial subscription payload for `desiredIdsRef.current`.
5. Never send unsubscribe frames after a connection has already closed.

### Acceptance Checks

- An unexpected close changes the UI to disconnected.
- A new connection attempt starts after approximately two seconds.
- Reconnection subscribes only to the currently selected game's IDs.
- Only one reconnect timer and one heartbeat interval exist at a time.
- Intentional unmount does not reconnect.

---

## Phase 5: Avoid Full-Table Row Renders

### File

- `src/App.tsx`

### Use stable per-asset objects

Every message handler must follow these rules:

1. Read the existing asset object from the previous map.
2. Compare incoming values with existing values.
3. If no value changed, keep the existing object and do not call `next.set` for that asset.
4. Create a new object only for an asset whose bid, ask, last trade, tick size, or flash metadata changed.
5. If a whole message produces no changes, return `prev` instead of returning a new `Map`.

These rules guarantee unchanged assets retain the same object references.

### Memoize `MarketRow`

1. Import `memo` from React.
2. Rename the current function implementation to `MarketRowComponent`.
3. Export or define the memoized component:

```ts
const MarketRow = memo(MarketRowComponent);
```

The default shallow comparison is sufficient only if unchanged `market` and `prices` object references remain stable.

### Do not do these things

- Do not clone every `MarketPrice` object when creating a new map.
- Do not create `{ ...prices }` while passing the prop to a row.
- Do not regenerate market objects on every price message.
- Do not put the entire price map into each row prop.

### Acceptance Checks

- A bid update for one token rerenders only that token's row.
- Other rows receive the exact same `prices` object references as before.
- A duplicate update containing the same values returns the previous map and triggers no render.
- The table still displays every moneyline and total outcome.

Use React DevTools Profiler or temporary render counters during development. Remove temporary counters before completion.

---

## Phase 6: Add 500 ms Cell Flash Indicators

### Files

- `src/App.tsx`
- `src/App.css`

### Flash-state helper

Add a pure helper:

```ts
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
```

Initial `book` snapshots must not flash because they have no meaningful previous value.

### Update flash metadata

For every `price_change`:

1. Save the old bid, old ask, and old spread.
2. Parse the next bid and ask.
3. Calculate the next spread.
4. Call `getNextFlash` independently for bid, ask, and spread.
5. Preserve the existing last-trade flash.

For every `last_trade_price`:

1. Compare the old and new last-trade values.
2. Update only `flashes.lastTrade`.
3. Preserve bid, ask, and spread flash metadata.

### Render cell classes

Add a small `PriceCell` component that accepts:

```ts
type PriceCellProps = {
  label: string;
  value: number | null;
  tickSize: string | null;
  flash: PriceFlash | null;
  className?: string;
};
```

Render each table cell with:

- `flash-up` when direction is `up`.
- `flash-down` when direction is `down`.
- A React `key` containing `flash.sequence`, for example:

```tsx
key={`${label}-${flash?.sequence ?? 0}`}
```

Changing the key remounts only that cell and restarts the CSS animation even if two consecutive changes move in the same direction.

### CSS

Add:

```css
.price-cell.flash-up {
  animation: price-flash-up 500ms ease-out;
}

.price-cell.flash-down {
  animation: price-flash-down 500ms ease-out;
}

@keyframes price-flash-up {
  0% {
    background: rgba(22, 163, 74, 0.28);
  }
  100% {
    background: transparent;
  }
}

@keyframes price-flash-down {
  0% {
    background: rgba(220, 38, 38, 0.24);
  }
  100% {
    background: transparent;
  }
}
```

Add an existing-project-compatible reduced-motion rule so users who prefer reduced motion receive a static, short-lived color change or no animation.

No JavaScript timeout is required; the CSS animation fades automatically after exactly 500 ms.

### Acceptance Checks

- Increasing bid, ask, last trade, or spread flashes green.
- Decreasing bid, ask, last trade, or spread flashes red.
- Initial snapshot values do not flash.
- An unchanged value does not flash.
- Two consecutive increases restart the green animation.
- Only the changed cell remounts and animates.
- The highlight is visually gone after 500 ms.

---

## Phase 7: Refresh the Event List Safely

### File

- `src/utils/utils.ts`
- `src/App.tsx`

### React Query settings

Update `useGetNflGames`:

```ts
return useQuery({
  queryKey: ["nflGames"],
  queryFn: getNflGames,
  staleTime: 30_000,
  refetchInterval: 60_000,
});
```

Do not restore the removed `endDate` filter.

### Handle a removed selected game

After reading `games`, add an effect in `NFLMarketDashboard`:

```ts
useEffect(() => {
  if (
    selectedGameId &&
    games &&
    !games.some((game) => game.id === selectedGameId)
  ) {
    setSelectedGameId("");
  }
}, [games, selectedGameId]);
```

This prevents `selectedGame!` from becoming null after a refresh removes a closed game.

### Acceptance Checks

- The event API refetches every 60 seconds.
- Newly opened NFL games appear without a page reload.
- Games no longer returned by `active=true&closed=false` disappear.
- If the selected game disappears, the UI returns to the selection state without throwing.
- A game remains selectable after kickoff while the API still returns it as active and open.

---

## Phase 8: Safely Parse WebSocket Messages

### Files

- `src/App.tsx`
- `src/types/gamma-api.ts`

### Add a supported-event guard

Create:

```ts
const SUPPORTED_EVENT_TYPES = new Set([
  "book",
  "price_change",
  "last_trade_price",
  "tick_size_change",
]);

function isMarketMessage(value: unknown): value is MarketMessage {
  if (!value || typeof value !== "object") return false;

  const eventType = (value as { event_type?: unknown }).event_type;
  return typeof eventType === "string" && SUPPORTED_EVENT_TYPES.has(eventType);
}
```

This is a minimal event-type guard, not complete schema validation.

### Replace unguarded parsing

Use:

```ts
socket.onmessage = (event) => {
  if (event.data === "PONG") return;

  try {
    const parsed: unknown = JSON.parse(event.data);
    const messages = Array.isArray(parsed) ? parsed : [parsed];

    for (const message of messages) {
      if (isMarketMessage(message)) {
        handleMessage(message);
      }
    }
  } catch (error) {
    console.error("Unable to parse market WebSocket message", error);
  }
};
```

Do not close the socket because one malformed message was received.

### Acceptance Checks

- `PONG` is ignored.
- A supported single object is processed.
- An array of supported objects is processed.
- Unknown event types are ignored.
- Malformed JSON is logged and does not stop later valid updates.

---

## Phase 9: Safely Parse Gamma API Data

### File

- `src/utils/utils.ts`

### Guard JSON string arrays

Replace `parseStringArray` with a non-throwing implementation:

```ts
const parseStringArray = (value: string[] | string): string[] => {
  if (Array.isArray(value)) return value;

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
};
```

### Guard each event before use

After parsing a Gamma page:

1. Confirm the page is an array. Throw a clear API-shape error if it is not.
2. Before testing `ev.slug`, confirm:
   - `ev` is a non-null object.
   - `ev.slug` is a string.
   - `ev.id` is a string.
   - `ev.title` is a string.
   - `ev.startTime` is a string.
   - `ev.markets` is an array.
3. Skip malformed individual events instead of failing every valid event in that page.

Do not add a validation package for this small payload surface.

### Acceptance Checks

- A malformed `outcomes` JSON string causes only that market to be skipped.
- A malformed `clobTokenIds` JSON string causes only that market to be skipped.
- A malformed event object does not prevent other page events from loading.
- A non-array page response produces a clear fetch error.

---

## Phase 10: Resolve Hook Dependencies and Clean Up

### Files

- `src/App.tsx`
- `src/utils/utils.ts`

### Rules

1. `handleMessage` should be wrapped in `useCallback` only after all mutable subscription data it needs has moved into refs.
2. The socket connection effect should depend only on stable callbacks such as `connect`.
3. The subscription effect should depend on `subscriptionIds` and `replaceSubscriptions`.
4. Never silence `react-hooks/exhaustive-deps` with a disable comment.
5. Remove the commented `tick_size_change` branch after implementing the real one.
6. Remove obsolete comments that describe the old reconnect-on-selection design.
7. Do not leave temporary logs, render counters, or test-only buttons.

### Acceptance Checks

- `pnpm lint` has no warnings.
- Selecting a game does not restart the connection effect.
- Price updates do not restart either WebSocket-related effect.
- Changing games runs only the subscription effect.

---

## Final Manual Test Script

Perform these steps in order after all phases are complete.

### Event selection

1. Load the app.
2. Confirm the selector contains only slugs matching the required game pattern.
3. Confirm a game that has started but remains active/open is still selectable.
4. Leave the page open for over 60 seconds and confirm the event query refetches.

### Initial market load

1. Select a game.
2. Confirm exactly one initial market subscription frame is sent.
3. Confirm all moneyline and full-game-total token IDs are included.
4. Confirm each row receives bid, ask, and last-trade values from its first book snapshot.
5. Confirm empty book sides display `—`.
6. Confirm initial values do not flash.

### Live updates

1. Observe a `price_change` message with multiple assets.
2. Confirm each changed asset receives its own supplied best bid and ask.
3. Confirm only affected rows rerender.
4. Confirm increasing cells flash green and decreasing cells flash red.
5. Confirm the flash is gone after 500 ms.
6. Observe a `last_trade_price` and confirm only that asset's last-trade cell updates.
7. Observe or simulate a `tick_size_change` and confirm display precision changes.

### Event switching

1. Select game A and wait for values.
2. Select game B.
3. Confirm the browser keeps the same WebSocket connection.
4. Confirm an unsubscribe frame contains all game A token IDs.
5. Confirm a subscribe frame contains all game B token IDs.
6. Confirm game A prices disappear immediately.
7. Confirm late game A messages do not repopulate state.
8. Confirm game B receives initial snapshots and then live updates.

### Connection reliability

1. Confirm a literal `PING` frame is sent every 10 seconds.
2. Force the socket closed unexpectedly.
3. Confirm the UI becomes disconnected.
4. Confirm reconnect starts after approximately two seconds.
5. Confirm the current game's IDs are resubscribed after reconnect.
6. Navigate away and confirm no reconnect occurs after unmount.

### Error handling

1. Feed malformed JSON to the message parser and confirm it logs an error without crashing.
2. Feed an unknown event type and confirm it is ignored.
3. Confirm a malformed market array string skips that market instead of breaking the event list.

## Definition of Done

The work is complete only when all of the following are true:

- Every row displays tick-correct bid, ask, last trade, and spread.
- All four required WebSocket event types are handled.
- Only one socket is used while switching games.
- Old IDs are unsubscribed before new IDs are subscribed.
- The heartbeat survives game switches.
- Only changed token rows rerender.
- Changed cells flash in the correct direction and fade after 500 ms.
- Initial snapshots are accepted once per asset per connection.
- Old game state and late messages cannot leak into the new game.
- Event data refreshes without hiding active games at kickoff.
- Malformed inputs do not crash the dashboard.
- `pnpm build` passes.
- `pnpm lint` passes with zero warnings.
