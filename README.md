# meta-dup

Standalone duplicate detection service for MetaMesh v2. Detects duplicate files by:
- **Hash**: Files with identical content — same `midhash256` (record address) seen at several paths, or same full-file SHA-256
- **Title**: Files with the same parsed title (+ year / season / episode when known)

> **Status: not wired into the current stack.** meta-dup was removed from the main dev compose (`dev/docker-compose.yml`) in March 2026 and has no MetaAppStore app. Its storage layer still talks to Redis directly (ioredis + Redis Streams), while meta-core has since stopped publishing a `redisUrl` (api-mediated-access lockdown) — so against a current meta-core it has no Redis to connect to. meta-fuse shows the migrated pattern (HTTP reads via `/meta/{hash}*` + SSE `/api/events/meta`). Treat the sections below as a description of the code, not of a running service.

## Architecture

meta-dup is a read-only service that:
1. Locates meta-core over UDP multicast (beacon v2, `239.255.99.1:9099`) — or uses `META_CORE_URL` when pinned
2. Builds an in-memory duplicate index from every record in Redis on startup
3. Consumes Redis Streams for real-time updates (`file:events` for file add/change/delete/rename, `meta:events` for title-field changes)
4. Provides a REST API and web dashboard (nginx on port 80 → Fastify on 3000)

```
meta-core ──► Redis Streams ──► meta-dup ──► Dashboard / REST API
              (file:events,     (consumer)
               meta:events)
```

See [beacon-v2.md](../../docs/project-architecture/beacon-v2.md) for the discovery protocol.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with stats (`status: ok\|degraded`) |
| `/api/duplicates` | GET | All duplicates (hash + title) |
| `/api/duplicates/hash` | GET | Hash duplicates only |
| `/api/duplicates/title` | GET | Title duplicates only |
| `/api/duplicates/stats` | GET | Duplicate statistics |
| `/api/duplicates/rebuild` | POST | Force rebuild from Redis |
| `/api/neighbors` | GET | Services heard over beacon v2 (dashboard nav menu) |

## Response Format

```json
{
  "hashDuplicates": [
    {
      "key": "<midhash256 or sha256>",
      "files": [
        { "hashId": "...", "filePath": "/files/...", "sizeByte": 123456 }
      ]
    }
  ],
  "titleDuplicates": [...],
  "stats": {
    "hashGroupCount": 5,
    "hashFileCount": 12,
    "titleGroupCount": 3,
    "titleFileCount": 7,
    "totalFilesTracked": 100,
    "lastUpdated": "2026-01-01T00:00:00.000Z"
  },
  "computedAt": "2026-01-01T00:00:00.000Z"
}
```

## Development

### Build
```bash
cd packages/meta-dup
pnpm install
pnpm build
```

### Docker image
```bash
docker build -t meta-dup .
# The image also copies the meta-core binary from META_CORE_IMAGE
# (default ghcr.io/worph/meta-core:latest) and runs it under supervisord.
```

CI publishes `ghcr.io/worph/meta-dup` on `v*` tags (`.github/workflows/docker-publish.yml`).

### Dev stack / tests
The main dev stack no longer defines a meta-dup container, so `dev/scripts/reload-meta-dup.sh` (targets container `meta-dup`) and the `dup` suite of `dev/test/test.sh` have nothing to run against until it is re-added.

## Configuration

meta-core is located over UDP (beacon v2); no `/meta-core` volume mount or `REDIS_URL` is needed.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `META_CORE_URL` | — | Pin meta-core's API URL; UDP discovery never overrides it |
| `ENABLE_UDP_DISCOVERY` | on | Set `false`/`0` to disable meta-discovery |
| `BASE_URL` | — | External URL (announced for the nav menu) |
| `PUBLIC_URL` | — | Announced URL; wins over `BASE_URL` (debug-direct, no Caddy) |
| `API_PORT` | `3000` | Internal API port (nginx proxies to 80) |
| `API_HOST` | `0.0.0.0` | API bind address |
| `REDIS_PREFIX` | `''` | Key prefix in Redis |
| `FILES_VOLUME` | `/files` | Prepended to the relative `filePath` of each record |
| `ALLOW_LEGACY_REDIS_URL` | — | `1` downgrades the "meta-core still publishes redisUrl" startup error to a warning |

## Package Structure

```
packages/meta-dup/
├── package.json            # Workspace root
├── pnpm-workspace.yaml
├── Dockerfile
├── docker/                 # nginx.conf, supervisord.conf
└── packages/
    ├── meta-dup-core/      # Backend service
    │   ├── src/
    │   │   ├── index.ts              # Entry point, file:events consumer
    │   │   ├── DuplicateIndex.ts     # Core duplicate detection
    │   │   ├── MetaEventConsumer.ts  # meta:events consumer (title updates)
    │   │   ├── api/
    │   │   │   └── APIServer.ts      # Fastify REST API
    │   │   ├── discovery/
    │   │   │   └── meshdisco.ts      # beacon v2 (mirrored, see scripts/check-mirrors.sh)
    │   │   └── kv/                   # Redis client + meta-core locator (LeaderClient)
    │   └── package.json
    └── meta-dup-ui/        # React dashboard
        ├── src/
        │   ├── App.tsx
        │   └── main.tsx
        └── package.json
```

## How Duplicate Detection Works

### Hash Duplicates
- **Path-based**: `file:events` add/change/rename messages carry `midhash256` + `path`; one midhash seen at several paths is a duplicate.
- **Full hash**: the full-file SHA-256 is read from the record's bare-CID key-set (`cids/<cid>`, picking the sha2-256 multicodec). Records with the same SHA-256 are exact content duplicates. See [METADATA_KEYS.md](../../METADATA_KEYS.md).

### Title Duplicates
Files resolving to the same normalized key `title[:year][:sN][:eN]`. Useful for finding different quality versions of the same content. Title fields (`title`, `originalTitle`, `fileName`, `year`, `movieYear`, `season`, `episode`, `tmdb`) are re-read on `meta:events` changes, debounced 500 ms.

## Redis Streams Integration

| Stream | Consumer group | Handles |
|--------|----------------|---------|
| `file:events` | `meta-dup-consumer` | `add`, `change`, `delete`, `rename`; legacy `batch`, `reset`, `plugin:complete` |
| `meta:events` | `meta-dup-meta-consumer` | `set`/`del` on `file:{hashId}/{field}` for title fields |

On startup, meta-dup:
1. Rebuilds the full index from Redis (via the `file:__index__` set)
2. Creates/joins the `file:events` consumer group
3. Processes pending entries idle > 30 s
4. Starts listening for new events on both streams
