# icmprut-server

> **icmprut** — *ICMP* + *sprut* (octopus): a many-armed prober whose tentacles
> reach every host in every network. This service is its eye — a live,
> force-directed "cloud" of all probe participants and their cross-links.

UI + API server that visualises the `ping` data that
[`icmprut-agent`](https://github.com/ivan-mezentsev/icmprut-agent) instances
write into [InfluxDB 3 Core](https://docs.influxdata.com/influxdb3/core/).

## What it shows

- **Living network cloud** — a d3-force layout of every participant
  (`src ∪ dst`), nodes draggable, double-click to reheat the simulation.
  The layout spreads nodes to fill the canvas (forces scale with node count) and
  a **zoom/pan camera** (scroll / pinch to zoom, drag empty space to pan,
  auto-fit) keeps it usable from 7 to ~100+ nodes.
- **Compact cross-links coloured by packet loss** — the server aggregates every
  directed connection between a node pair (all `netspace` / `family` /
  directions) into **one** line, whose segments are tinted along its length by
  the worst-case loss of each time bucket (green → amber → red). The visual
  timeline is deterministic: **past reads from the left/top end, current time
  (`now`) is marked at the right/bottom end**. Recent lossy segments glow more
  strongly than older ones, so "when did it happen?" is visible before hover.
  This keeps the cloud readable at production scale; the full per-direction /
  per-netspace breakdown is preserved in the hover tooltip.
- **Grafana-style hover** — a value list for the bucket under the cursor, a
  range summary (loss avg/max, RTT min/avg/max, sent/recv), and the list of
  underlying connections that the aggregated link represents. Clicking a link
  pins the tooltip; the selected link stays highlighted while the pinned tooltip
  is open.
- **Brush-to-zoom** — drag along a link to select a sub-interval; the whole
  dashboard time range snaps to it.
- **Global network quality strip** — the lower edge of the top bar is a compact
  loss timeline for the whole visible graph. It renders per-bucket worst-case
  loss and its hover also reports weighted-average loss plus the number of bad
  links. Dragging the strip selects a time range.
- **Grafana-style time picker** — defaults to **Last 15 minutes**, plus other
  relative presets and absolute from/to. The selected time range is reflected in
  the URL as `from` / `to` query parameters.
- **Link-type filter** — toggle the `netspace` values discovered from InfluxDB;
  all enabled by default. The UI does not hardcode or rename netspace values.
  Selected values are reflected in the URL as repeated Grafana-style
  `var-netspace=<value>` parameters.

## Architecture

```
browser (React 19 + Canvas)
   │  /api/graph, /api/meta   (token never leaves the server)
   ▼
Node 26 API server  ──►  QueryCache (TTL + single-flight coalescing)  ──►  InfluxDB 3 Core (SQL)
   │
   └── serves the built SPA (dist/)
```

The server (`server/`) is pure Node 26 stdlib — no web framework — and holds the
InfluxDB bearer token (it never reaches the browser). The cache layer is built
for the planned **multi-user** mode: identical queries arriving together trigger
exactly one upstream call (coalescing), and results are reused within a TTL
(short for live ranges, long for historical ones). A configurable **settling
window** keeps the short TTL for any range whose end is recent, so late writes
from a previously-offline agent (backfilling past windows) are never hidden by
the cache.

| Module | Responsibility |
| --- | --- |
| `server/config.js` | Env-driven configuration |
| `server/influx.js` | InfluxDB 3 SQL client (native `fetch`) |
| `server/cache.js` | LRU cache + single-flight coalescing |
| `server/timerange.js` | Grafana-style range resolution & bucket sizing |
| `server/queries.js` | Safe SQL builders for the `ping` measurement |
| `server/graph-service.js` | Folds rows → `{nodes, edges[buckets]}` |
| `server/static.js` | SPA static file serving |
| `server/index.js` | HTTP server + routes |

## API

- `GET /api/health` — liveness + cache stats.
- `GET /api/meta?from=now-15m&to=now` — node universe, netspaces, families
  **scoped to the time window**. The available filter values reflect only what
  was observed within `[from, to)`, exactly like `/api/graph` (a host removed
  before the window, or a netspace that did not exist yet, does not appear).
  `from`/`to` default to `now-15m`/`now` and accept the same tokens as `/api/graph`.
- `POST /api/graph` — body `{ from, to, filters: { netspaces?, families? }, maxBuckets? }`.
  `from`/`to` accept relative tokens (`now-15m`), epoch ms, or ISO strings.
  Also available as `GET /api/graph?from=now-15m&to=now&netspaces=<value>,<value>`.

## Shareable UI URLs

The browser UI keeps its main state in the address bar using Grafana-compatible
query parameters:

- `from` / `to` — relative tokens (`now-15m`, `now`) or epoch milliseconds.
- `var-netspace=<value>` — repeated once per selected link type.

Examples:

```text
/?from=now-15m&to=now
/?from=1740070380000&to=1740071880000&var-netspace=private&var-netspace=wan
```

If every discovered netspace is enabled, `var-netspace` is omitted and treated
as “all”. The legacy API-style `netspaces=a,b` parameter is still accepted by
the UI on read, but newly written UI URLs use `var-netspace`.

## Configuration (env)

All configuration is supplied via environment variables. See
[`.env_example`](.env_example) for a complete, commented template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ICMPRUT_INFLUXDB_URL` | `http://127.0.0.1:8181` | Upstream InfluxDB base URL |
| `ICMPRUT_INFLUXDB_TOKEN` | – | Bearer token (server-side only) |
| `ICMPRUT_INFLUXDB_DB` | `icmprut` | Database name |
| `ICMPRUT_INFLUXDB_TIMEOUT_MS` | `30000` | Per-request upstream timeout |
| `ICMPRUT_SERVER_HOST` | `0.0.0.0` | HTTP bind address |
| `ICMPRUT_SERVER_PORT` | `3089` | HTTP listen port |
| `ICMPRUT_CACHE_LIVE_TTL_MS` | `10000` | TTL for live (now-tracking) queries |
| `ICMPRUT_CACHE_HISTORY_TTL_MS` | `300000` | TTL for historical queries |
| `ICMPRUT_CACHE_MAX_ENTRIES` | `512` | Max cached entries (LRU eviction) |
| `ICMPRUT_CACHE_NOW_QUANT_MS` | `10000` | "now" quantisation for shared cache keys |
| `ICMPRUT_CACHE_SETTLE_MS` | `600000` | Recent-data window that forces the short TTL (late backfill) |

## Quick start (Docker Compose)

```bash
# 1. Create your environment file from the template
cp .env_example .env

# 2. Edit .env: set the InfluxDB URL/token
$EDITOR .env

# 3. Build and start
docker compose up -d --build

# 4. Open the UI
open http://127.0.0.1:3089
```

## Development

```bash
npm install
# Single command: runs the API server (:3089) and Vite (proxying /api)
ICMPRUT_INFLUXDB_URL=http://127.0.0.1:8181 \
ICMPRUT_INFLUXDB_TOKEN=apiv3_… \
npm run dev
```

`npm run dev` starts both the API server (`server/index.js`, watched) and Vite,
which proxies `/api` to the API server.

## Production

```bash
npm run build   # → dist/
npm run start   # Node server serves dist/ + /api on :3089
```

Container build/run is wired in `Dockerfile` + `docker-compose.yaml`.

## License

[MIT](LICENSE)
