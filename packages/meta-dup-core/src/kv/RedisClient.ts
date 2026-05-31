/**
 * Redis Client for meta-dup
 * Reads metadata from Redis (written by meta-sort)
 *
 * Key features:
 * - FILES_VOLUME path resolution (prepends /files/ to relative paths)
 * - Parses meta-sort hash format into structured metadata
 * - Redis Streams support for real-time updates
 */

import { Redis } from 'ioredis';
import { Logger } from 'tslog';
import * as os from 'os';
import type { IKVClient, KeyValuePair } from './IKVClient.js';

const logger = new Logger({ name: 'RedisClient' });

// --- bare-CID key-set decoding -------------------------------------------
// Sibling CIDs live on the record as a key-set `cids/<cid> = "true"` (no
// per-algorithm field name). A CIDv1 is self-describing — its algorithm is
// the multicodec — so we decode each member's multihash code to pick the
// digest we need: sha2-256 (0x12) is the full-file content hash used for
// exact-duplicate detection; midhash256 (0x1000) is the record address.
// Self-contained decoder (no multiformats dep). See METADATA_KEYS.md §2/§14.13.
const MH_SHA256 = 0x12;
const MH_MIDHASH256 = 0x1000;
const CID_B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function decodeBase32Lower(s: string): Uint8Array | null {
    let bits = 0, value = 0;
    const out: number[] = [];
    for (const ch of s) {
        const idx = CID_B32_ALPHABET.indexOf(ch);
        if (idx < 0) return null;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

function readUvarint(buf: Uint8Array, pos: number): [number, number] {
    let result = 0, shift = 0, p = pos;
    while (p < buf.length) {
        const b = buf[p++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return [result >>> 0, p];
        shift += 7;
    }
    return [0, pos];
}

/** Multihash code of a bare multibase-base32 CIDv1, or null. */
function cidMultihashCode(cid: string): number | null {
    if (!cid.startsWith('b')) return null;
    const bytes = decodeBase32Lower(cid.slice(1));
    if (!bytes || bytes.length < 3) return null;
    let v: number, pos = 0;
    [v, pos] = readUvarint(bytes, pos); // version
    if (v !== 1) return null;
    [v, pos] = readUvarint(bytes, pos); // codec (ignored)
    [v, pos] = readUvarint(bytes, pos); // multihash code
    return v;
}

/** Pick the sibling CID with the given multihash code from a record's
 *  `cids/<cid>` key-set. */
function pickCidByMulticodec(data: Record<string, any>, mhCode: number): string | undefined {
    for (const key of Object.keys(data)) {
        if (!key.startsWith('cids/')) continue;
        const cid = key.slice('cids/'.length);
        if (cid && cidMultihashCode(cid) === mhCode) return cid;
    }
    return undefined;
}

/**
 * Stream message from Redis Streams
 * Supports both:
 * - Direct file events from meta-core (add/change/delete/rename)
 * - Legacy batch events from meta-sort (batch/reset/plugin:complete)
 */
export interface StreamMessage {
    id: string;
    type: 'add' | 'change' | 'delete' | 'rename' | 'batch' | 'reset' | 'plugin:complete';
    // Direct file event fields (from meta-core)
    path?: string;
    size?: string;
    midhash256?: string;  // midhash256 CID computed by meta-core
    oldPath?: string;
    // Legacy payload field (for backward compatibility)
    payload?: string;
    timestamp: string;
}

/**
 * Stream consumer callback
 */
export type StreamMessageHandler = (message: StreamMessage) => Promise<void>;

/**
 * File metadata structure for duplicate detection
 */
export interface FileMetadata {
    // Path information
    sourcePath: string;      // Full path: /files/media1/Movies/...
    originalPath: string;    // Relative path from meta-sort: media1/Movies/...

    // File stats
    size: number;
    mtime: number;
    ctime: number;

    // Identification
    hashId?: string;         // midhash256 hash ID
    sha256?: string;         // Full SHA-256 hash for duplicate detection

    // Title information (for folder organization)
    title?: string;
    titles?: { eng?: string; [key: string]: string | undefined };
    originalTitle?: string;
    fileName?: string;

    // Series metadata
    season?: number;
    episode?: number;
    extra?: boolean;

    // Movie metadata
    movieYear?: number;
    year?: number;

    // File type
    fileType?: string;       // 'video', 'subtitle', 'torrent', etc.
    extension?: string;

    // Version/variant info
    version?: string;
    subtitleLanguage?: string;

    // Generic metadata container
    [key: string]: unknown;
}

export interface RedisClientConfig {
    url?: string;
    prefix?: string;
    filesVolume?: string;
    reconnectInterval?: number;
}

export class RedisClient implements Partial<IKVClient> {
    private client: Redis | null = null;
    private subscriber: Redis | null = null;
    private config: Required<RedisClientConfig>;
    private isConnected = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private subscriptions: Map<string, (message: string) => void> = new Map();

    // Stream consumer state
    private streamConsumerRunning = false;
    private streamConsumerAbort: AbortController | null = null;
    private consumerName: string;

    constructor(config: RedisClientConfig = {}) {
        this.config = {
            url: config.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
            prefix: config.prefix ?? process.env.REDIS_PREFIX ?? '',
            filesVolume: config.filesVolume ?? process.env.FILES_VOLUME ?? '/files',
            reconnectInterval: config.reconnectInterval ?? 5000,
        };

        // Unique consumer name for this instance
        this.consumerName = `${os.hostname()}-${process.pid}`;
    }

    /**
     * Connect to Redis
     */
    async connect(): Promise<void> {
        if (this.client && this.isConnected) {
            return;
        }

        try {
            this.client = new Redis(this.config.url, {
                retryStrategy: (times: number) => {
                    if (times > 10) {
                        logger.warn('Max reconnection attempts reached');
                        return null;
                    }
                    return Math.min(times * 500, 5000);
                },
                maxRetriesPerRequest: 3,
            });

            this.client.on('connect', () => {
                logger.info('Connected to Redis');
                this.isConnected = true;
            });

            this.client.on('error', (err: Error) => {
                logger.error('Redis error:', err.message);
                this.isConnected = false;
            });

            this.client.on('close', () => {
                logger.warn('Redis connection closed');
                this.isConnected = false;
                this.scheduleReconnect();
            });

            // Wait for connection
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Redis connection timeout'));
                }, 10000);

                this.client!.once('ready', () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    resolve();
                });

                this.client!.once('error', (err: Error) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
        } catch (error) {
            logger.error('Failed to connect to Redis:', error);
            this.scheduleReconnect();
            throw error;
        }
    }

    /**
     * Schedule reconnection attempt
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
            } catch {
                // Will retry via scheduleReconnect
            }
        }, this.config.reconnectInterval);
    }

    /**
     * Disconnect from Redis
     */
    async disconnect(): Promise<void> {
        // Stop stream consumer first
        this.stopStreamConsumer();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.subscriber) {
            await this.subscriber.quit();
            this.subscriber = null;
        }

        if (this.client) {
            await this.client.quit();
            this.client = null;
            this.isConnected = false;
        }

        this.subscriptions.clear();
    }

    /**
     * Check if connected
     */
    get connected(): boolean {
        return this.isConnected;
    }

    /**
     * Get all file metadata from Redis
     */
    async getAllFiles(): Promise<Map<string, FileMetadata>> {
        const files = new Map<string, FileMetadata>();

        if (!this.client || !this.isConnected) {
            logger.warn('Redis not connected, returning empty file list');
            return files;
        }

        try {
            // Get all file keys using the index
            const indexKey = `${this.config.prefix}file:__index__`;
            const hashIds = await this.client.smembers(indexKey);

            if (hashIds.length === 0) {
                // Fallback: scan for file keys directly
                const pattern = `${this.config.prefix}file:*`;
                const keys = await this.scanKeys(pattern);
                logger.debug(`Found ${keys.length} file keys in Redis (via scan)`);

                for (const key of keys) {
                    if (key.includes('__index__')) continue;

                    try {
                        const data = await this.client.hgetall(key);
                        if (data && Object.keys(data).length > 0) {
                            const hashId = key.replace(`${this.config.prefix}file:`, '');
                            const metadata = this.parseMetadata(data, hashId);
                            files.set(hashId, metadata);
                        }
                    } catch (err) {
                        logger.warn(`Failed to get metadata for key ${key}:`, err);
                    }
                }
            } else {
                logger.debug(`Found ${hashIds.length} files in index`);

                // Fetch metadata for each hash ID
                for (const hashId of hashIds) {
                    try {
                        const key = `${this.config.prefix}file:${hashId}`;
                        const data = await this.client.hgetall(key);
                        if (data && Object.keys(data).length > 0) {
                            const metadata = this.parseMetadata(data, hashId);
                            files.set(hashId, metadata);
                        }
                    } catch (err) {
                        logger.warn(`Failed to get metadata for hashId ${hashId}:`, err);
                    }
                }
            }

            logger.info(`Loaded ${files.size} files from Redis`);
        } catch (error) {
            logger.error('Failed to get files from Redis:', error);
        }

        return files;
    }

    /**
     * Get file metadata by hash ID
     */
    async getFileByHashId(hashId: string): Promise<FileMetadata | null> {
        if (!this.client || !this.isConnected) {
            return null;
        }

        try {
            const key = `${this.config.prefix}file:${hashId}`;
            const data = await this.client.hgetall(key);

            if (data && Object.keys(data).length > 0) {
                return this.parseMetadata(data, hashId);
            }

            return null;
        } catch (error) {
            logger.error(`Failed to get file ${hashId}:`, error);
            return null;
        }
    }

    /**
     * Get all hash IDs from Redis index
     */
    async getAllHashIds(): Promise<string[]> {
        if (!this.client || !this.isConnected) {
            return [];
        }

        try {
            const indexKey = `${this.config.prefix}file:__index__`;
            return await this.client.smembers(indexKey);
        } catch (error) {
            logger.error('Failed to get hash IDs:', error);
            return [];
        }
    }

    /**
     * Scan Redis keys matching pattern
     */
    private async scanKeys(pattern: string): Promise<string[]> {
        if (!this.client) return [];

        const keys: string[] = [];
        let cursor = '0';

        do {
            const [newCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
            cursor = newCursor;
            keys.push(...batch);
        } while (cursor !== '0');

        return keys;
    }

    /**
     * Parse metadata from Redis hash
     * Handles meta-sort format and resolves paths with FILES_VOLUME
     */
    private parseMetadata(data: Record<string, string>, hashId?: string): FileMetadata {
        // Get the original path (relative to FILES_VOLUME)
        const originalPath = data.filePath ?? data.sourcePath ?? '';

        // Resolve full source path by prepending FILES_VOLUME
        let sourcePath = originalPath;
        if (originalPath && !originalPath.startsWith('/')) {
            // Relative path - prepend FILES_VOLUME
            sourcePath = `${this.config.filesVolume}/${originalPath}`;
        } else if (!originalPath.startsWith(this.config.filesVolume) && originalPath.startsWith('/')) {
            // Absolute path but not in FILES_VOLUME - still prepend
            sourcePath = `${this.config.filesVolume}${originalPath}`;
        }

        // Parse size
        const size = parseInt(data.fileSize ?? data.size ?? data.sizeByte ?? '0', 10);

        // Parse timestamps
        let mtime = 0;
        if (data.mtime) {
            const parsed = Date.parse(data.mtime);
            mtime = isNaN(parsed) ? parseFloat(data.mtime) : parsed;
        }

        // Parse titles - can be nested object or simple string
        let titles: { eng?: string; [key: string]: string | undefined } | undefined;
        if (data['titles/eng']) {
            titles = { eng: data['titles/eng'] };
        }

        // Parse season/episode (can be 0 for specials)
        const season = data.season !== undefined ? parseInt(data.season, 10) : undefined;
        const episode = data.episode !== undefined ? parseInt(data.episode, 10) : undefined;

        // Parse year
        const movieYear = data.movieYear ? parseInt(data.movieYear, 10) : undefined;
        const year = data.year ? parseInt(data.year, 10) : movieYear;

        return {
            // Path information
            sourcePath,
            originalPath,

            // File stats
            size,
            mtime,
            ctime: data.ctime ? parseFloat(data.ctime) : mtime,

            // Identification. The midhash (record address) and the full-file
            // sha2-256 (exact-dup key) are recovered from the bare-CID
            // key-set by multicodec; legacy named fields kept as a
            // transition fallback. See METADATA_KEYS.md §2/§14.13.
            hashId: hashId ?? pickCidByMulticodec(data, MH_MIDHASH256) ?? data.cid_midhash256 ?? data.hashId,
            sha256: pickCidByMulticodec(data, MH_SHA256) ?? data['cid_sha2-256'] ?? data.sha256,

            // Title information
            title: data.title,
            titles,
            originalTitle: data.originalTitle,
            fileName: data.fileName,

            // Series metadata
            season,
            episode,
            extra: data.extra === 'true',

            // Movie metadata
            movieYear,
            year,

            // File type
            fileType: data.fileType,
            extension: data.extension,

            // Version/variant
            version: data.version,
            subtitleLanguage: data.subtitleLanguage,
        };
    }

    // ========================================================================
    // Redis Streams Consumer Methods
    // ========================================================================

    /**
     * Initialize stream consumer group
     * Creates the consumer group at position 0 to read all historical events
     *
     * @param stream - Stream name (e.g., 'meta-sort:events')
     * @param group - Consumer group name (e.g., 'meta-dup-consumer')
     */
    async initStreamConsumer(stream: string, group: string): Promise<void> {
        if (!this.client) {
            throw new Error('Redis not connected');
        }

        try {
            // Create consumer group at position 0 (read all historical events)
            // MKSTREAM creates the stream if it doesn't exist
            await this.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
            logger.info(`Created consumer group '${group}' for stream '${stream}'`);
        } catch (error: any) {
            // BUSYGROUP means group already exists - that's fine
            if (error.message?.includes('BUSYGROUP')) {
                logger.debug(`Consumer group '${group}' already exists`);
            } else {
                throw error;
            }
        }
    }

    /**
     * Process pending entries from crashed consumers
     * Uses XAUTOCLAIM to claim entries that have been idle too long
     *
     * @param stream - Stream name
     * @param group - Consumer group name
     * @param minIdleTime - Minimum idle time in ms before claiming (default: 30000)
     * @param onMessage - Handler for each message
     */
    async processPendingEntries(
        stream: string,
        group: string,
        minIdleTime: number = 30000,
        onMessage: StreamMessageHandler
    ): Promise<number> {
        if (!this.client) {
            return 0;
        }

        let processed = 0;
        let cursor = '0-0';

        try {
            while (true) {
                // XAUTOCLAIM claims idle entries and returns them
                const result = await this.client.xautoclaim(
                    stream,
                    group,
                    this.consumerName,
                    minIdleTime,
                    cursor,
                    'COUNT',
                    100
                ) as [string, Array<[string, string[]]>, string[]];

                const [nextCursor, entries] = result;
                cursor = nextCursor;

                if (!entries || entries.length === 0) {
                    break;
                }

                for (const [id, fields] of entries) {
                    try {
                        const message = this.parseStreamEntry(id, fields);
                        if (message) {
                            await onMessage(message);
                            // ACK the message after successful processing
                            await this.client.xack(stream, group, id);
                            processed++;
                        }
                    } catch (error: any) {
                        logger.error(`Error processing pending entry ${id}:`, error.message);
                    }
                }

                // If cursor is 0-0, we've processed all pending entries
                if (cursor === '0-0') {
                    break;
                }
            }

            if (processed > 0) {
                logger.info(`Processed ${processed} pending stream entries`);
            }
        } catch (error: any) {
            logger.error('Error processing pending entries:', error.message);
        }

        return processed;
    }

    /**
     * Start stream consumer loop
     * Reads messages using XREADGROUP and calls the handler
     *
     * @param stream - Stream name
     * @param group - Consumer group name
     * @param onMessage - Handler for each message
     * @param blockMs - Block timeout in ms (default: 5000)
     */
    async startStreamConsumer(
        stream: string,
        group: string,
        onMessage: StreamMessageHandler,
        blockMs: number = 5000
    ): Promise<void> {
        if (!this.client) {
            throw new Error('Redis not connected');
        }

        if (this.streamConsumerRunning) {
            logger.warn('Stream consumer already running');
            return;
        }

        this.streamConsumerRunning = true;
        this.streamConsumerAbort = new AbortController();

        logger.info(`Starting stream consumer: ${stream} (group: ${group}, consumer: ${this.consumerName})`);

        // Consumer loop
        while (this.streamConsumerRunning && !this.streamConsumerAbort.signal.aborted) {
            try {
                // XREADGROUP blocks waiting for new messages
                // '>' means only read new messages (not already delivered to this consumer)
                const result = await (this.client.call(
                    'XREADGROUP',
                    'GROUP', group,
                    this.consumerName,
                    'BLOCK', blockMs,
                    'COUNT', 10,
                    'STREAMS', stream,
                    '>'
                ) as Promise<Array<[string, Array<[string, string[]]>]> | null>);

                if (!result || result.length === 0) {
                    continue; // Timeout, loop again
                }

                // Process each stream's messages
                for (const [streamName, entries] of result) {
                    for (const [id, fields] of entries) {
                        try {
                            const message = this.parseStreamEntry(id, fields);
                            if (message) {
                                await onMessage(message);
                                // ACK the message after successful processing
                                await this.client!.xack(stream, group, id);
                            }
                        } catch (error: any) {
                            logger.error(`Error processing stream entry ${id}:`, error.message);
                            // Don't ACK on error - message will be reprocessed
                        }
                    }
                }
            } catch (error: any) {
                if (this.streamConsumerAbort?.signal.aborted) {
                    break;
                }
                logger.error('Stream consumer error:', error.message);
                // Brief pause before retrying
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        logger.info('Stream consumer stopped');
    }

    /**
     * Stop the stream consumer loop
     */
    stopStreamConsumer(): void {
        if (!this.streamConsumerRunning) {
            return;
        }

        logger.info('Stopping stream consumer...');
        this.streamConsumerRunning = false;
        this.streamConsumerAbort?.abort();
        this.streamConsumerAbort = null;
    }

    /**
     * Parse a stream entry into a StreamMessage
     * Handles both direct file events (add/change/delete/rename) and legacy batch events
     */
    private parseStreamEntry(id: string, fields: string[]): StreamMessage | null {
        // Fields come as flat array: ['type', 'add', 'path', '...', 'timestamp', '123']
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
        }

        if (!fieldMap.type) {
            logger.warn(`Invalid stream entry ${id}: missing type`);
            return null;
        }

        // For direct file events (add/change/delete/rename), path is required
        // For legacy events (batch/reset/plugin:complete), payload is required
        const directEventTypes = ['add', 'change', 'delete', 'rename'];
        const isDirectEvent = directEventTypes.includes(fieldMap.type);

        if (isDirectEvent && !fieldMap.path) {
            logger.warn(`Invalid stream entry ${id}: missing path for ${fieldMap.type} event`);
            return null;
        }

        if (!isDirectEvent && !fieldMap.payload) {
            logger.warn(`Invalid stream entry ${id}: missing payload for ${fieldMap.type} event`);
            return null;
        }

        return {
            id,
            type: fieldMap.type as StreamMessage['type'],
            path: fieldMap.path,
            size: fieldMap.size,
            midhash256: fieldMap.midhash256,
            oldPath: fieldMap.oldPath,
            payload: fieldMap.payload,
            timestamp: fieldMap.timestamp || '0',
        };
    }

    /**
     * Get stats about Redis data
     */
    async getStats(): Promise<{ totalKeys: number; fileCount: number; connected: boolean }> {
        if (!this.client || !this.isConnected) {
            return { totalKeys: 0, fileCount: 0, connected: false };
        }

        try {
            // Try index first
            const indexKey = `${this.config.prefix}file:__index__`;
            const count = await this.client.scard(indexKey);

            if (count > 0) {
                return {
                    totalKeys: count,
                    fileCount: count,
                    connected: true,
                };
            }

            // Fallback to scanning
            const filePattern = `${this.config.prefix}file:*`;
            const fileKeys = await this.scanKeys(filePattern);
            const actualFileKeys = fileKeys.filter(k => !k.includes('__index__'));

            return {
                totalKeys: actualFileKeys.length,
                fileCount: actualFileKeys.length,
                connected: true,
            };
        } catch {
            return { totalKeys: 0, fileCount: 0, connected: false };
        }
    }

    /**
     * Health check
     */
    async health(): Promise<boolean> {
        if (!this.client || !this.isConnected) {
            return false;
        }

        try {
            const result = await this.client.ping();
            return result === 'PONG';
        } catch {
            return false;
        }
    }

    /**
     * Close connections
     */
    async close(): Promise<void> {
        await this.disconnect();
    }

    /**
     * Get the raw ioredis client for direct access if needed
     * Use with caution - prefer using the typed methods above
     */
    getRawClient(): Redis | null {
        return this.client;
    }

    /**
     * Create a duplicate Redis connection for blocking stream consumers.
     * Each blocking consumer needs its own connection since XREADGROUP blocks.
     *
     * The caller is responsible for closing this connection.
     */
    createDuplicateConnection(): Redis | null {
        if (!this.isConnected) {
            logger.warn('Cannot create duplicate connection: not connected');
            return null;
        }

        try {
            const connection = new Redis(this.config.url, {
                retryStrategy: (times: number) => {
                    if (times > 10) {
                        return null;
                    }
                    return Math.min(times * 500, 5000);
                },
                maxRetriesPerRequest: 3,
            });

            connection.on('error', (err: Error) => {
                logger.error('Duplicate Redis connection error:', err.message);
            });

            return connection;
        } catch (error) {
            logger.error('Failed to create duplicate connection:', error);
            return null;
        }
    }
}
