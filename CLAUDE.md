# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Single-file web app (`index.html`) with a minimal Deno HTTP server (`server.ts`). No build step, no framework, no bundler — everything runs directly in the browser.

**Server** (`server.ts`): Serves `index.html` on port 80 and exposes `/api/routes` (GET/PUT) for persisting map route data to `data/routes.json` on the Fly.io volume. Route sync only applies to the built-in Glasgow event (`BUILTIN_EVENT_ID = 'pmg2026'`).

**Client** (`index.html`): ~4400 lines of vanilla HTML/CSS/JS. All state lives in `localStorage`. No external JS dependencies except Leaflet (loaded via CDN). The app is a mobile-first card-swiping interface for walking a race course and checking off setup tasks.

## Key Data Concepts

**Events**: Either the hard-coded built-in Glasgow 2026 event (`BUILTIN_EVENT_ID`) or user-created custom events stored in `localStorage` (`ofcourse_events`). Each custom event has per-event storage keys prefixed with its ID.

**Cards**: Each card (`CARDS` array or CSV-imported cards) represents a checkpoint with: `ref`, `dist`, `w3w`, `loc`, `hazard`, `netR`, `sig`, `equip`, `staff`, `info`, `resR`, `action`, `obstacle`. Custom field-addition cards additionally have `isCustom: true`, `parentRef`, `subIdx`.

**ALLCARDS**: The merged array of `activeCards` (base cards for the active event) interleaved with `state.customCards` (field additions). Always rebuild with `refreshAllCards()` after modifying either source.

**effectiveCard(card)**: Merges `state.cardEdits[card.ref]` on top of a card — always use `ec = effectiveCard(card)` when rendering, never read raw card fields directly.

**State key layout** (per event):
- `ofcourse_state_{id}` — progress, notes, edits, custom cards, audit log
- `ofcourse_cards_{id}` — CSV-imported cards array
- `ofcourse_pins_{id}` — map pin positions
- `ofcourse_routes_{id}` — route polyline data

## CSV Import Pipeline

1. User uploads CSV in the New Event form → `onCSVFileSelected()` → `parseRiskCSV()`
2. `parseRiskCSV` normalises headers (lowercase, spaces→`_`, strip non-alphanumeric) and maps them via `fieldMap` aliases
3. Parsed cards stored in `parsedCSVCards` (module-level var)
4. On "Create Event" → `createNewEvent()` saves cards to `ofcourse_cards_{id}` and stores `cardCount` in event metadata
5. On session start → `activateEvent(id)` → `loadEventCards(id)` → populates `activeCards`

Expected CSV columns (aliases in `parseRiskCSV` fieldMap): `ref`, `loc`/`location`/`description`, `hazard`, `net_risk`/`risk`, `sig`/`signage`, `equip`/`equipment`, `staff`, `info`/`information`, `res_risk`/`residual_risk`, `action`/`further_action`, `obstacle`.

## Rendering Flow

`renderCard(idx)` → reads `ALLCARDS[idx]` → calls `effectiveCard()` → builds card HTML. Custom cards (`isCustom`) branch to `renderCustomCard()`. Call `updateProgress()` after any state change affecting completion counts.

`initDistBar()` must be called whenever `activeCards` or `activeTotalDist` changes, and `refreshAllCards()` whenever `state.customCards` or `activeCards` changes.

## Deployment

Deployed on Fly.io via `fly deploy`. The `Dockerfile` runs `deno run server.ts`. Route data persists to a Fly volume; all other state is per-browser localStorage.

GitHub Actions workflow at `.github/workflows/fly-deploy.yml` deploys on push to `main`.

## Development

Open `index.html` directly in a browser — no server needed for local development (all features except map route sync work offline). For route sync testing, run the Deno server locally:

```bash
deno run --allow-net --allow-read --allow-write --allow-env server.ts
```
