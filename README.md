# meta-dup

Standalone duplicate detection service for MetaMesh v2. Detects duplicate files by:
- **Hash (SHA-256)**: Files with identical content
- **Title**: Files with the same parsed title (from filename patterns)

## Architecture

meta-dup is a read-only service that:
1. Subscribes to Redis Streams (`meta-sort:events`) for real-time updates
2. Maintains an in-memory index of duplicates
3. Provides REST API and web dashboard

```
meta-sort ──► Redis Streams ──► meta-dup ──► Dashboard (port 8183)
              (events)          (consumer)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with stats |
| `/api/duplicates` | GET | All duplicates (hash + title) |
| `/api/duplicates/hash` | GET | Hash duplicates only |
| `/api/duplicates/title` | GET | Title duplicates only |
| `/api/duplicates/stats` | GET | Duplicate statistics |
| `/api/duplicates/rebuild` | POST | Force rebuild from Redis |

## Response Format

```json
{
  "hashDuplicates": [
    {
      "key": "sha256-hash",
      "files": [
        { "hashId": "...", "filePath": "/files/...", "sizeByte": 123456 }
      ]
    }
  ],
  "titleDuplicates": [...],
  "stats": {
    "hashGroupCount": 5,
    "titleGroupCount": 3,
    "totalFilesTracked": 100
  },
  "computedAt": 1234567890
}
```

## Development

### Build
```bash
cd packages/meta-dup
pnpm install
pnpm build
```

### Run (in Docker dev environment)
```bash
cd dev
./start.sh  # Starts all services including meta-dup
```

### Rebuild
```bash
cd dev
./reload-meta-dup.sh
```

### Tests
```bash
docker exec meta-test-runner /app/test/test.sh dup
```

## Configuration

meta-dup uses service discovery via `/meta-core/locks/kv-leader.info` to find the Redis instance. No additional configuration required.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:8183` | External URL for service |
| `SERVICE_NAME` | `meta-dup` | Service identifier |
| `API_PORT` | `3000` | Internal API port (nginx proxies to 80) |

## Package Structure

```
packages/meta-dup/
├── package.json            # Workspace root
├── pnpm-workspace.yaml
└── packages/
    ├── meta-dup-core/      # Backend service
    │   ├── src/
    │   │   ├── index.ts           # Entry point
    │   │   ├── DuplicateIndex.ts  # Core duplicate detection
    │   │   ├── api/
    │   │   │   └── APIServer.ts   # Fastify REST API
    │   │   └── kv/                # Redis client & leader discovery
    │   └── package.json
    └── meta-dup-ui/        # React dashboard
        ├── src/
        │   ├── App.tsx
        │   └── main.tsx
        └── package.json
```

## How Duplicate Detection Works

### Hash Duplicates
Files with the same `cid_sha2-256` (full file hash) are exact content duplicates.

### Title Duplicates
Files parsed to the same title (e.g., "Movie Name (2020)") from their filename patterns. Useful for finding different quality versions of the same content.

## Redis Streams Integration

meta-dup subscribes to `meta-sort:events` stream with consumer group `meta-dup-consumer`:

```
Event types:
- batch: File batch processed (add/update duplicates)
- reset: Full index rebuild required
```

On startup, meta-dup:
1. Creates/joins consumer group
2. Processes any pending entries
3. Rebuilds full index from Redis `file:*` keys
4. Starts listening for new events
