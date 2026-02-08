/**
 * meta-dup-core entry point
 *
 * Standalone duplicate detection service that:
 * - Consumes Redis Streams events from meta-sort
 * - Detects duplicates by hash (SHA-256) and by title
 * - Provides REST API and UI dashboard
 *
 * Uses Redis Streams for reliable event delivery from meta-sort.
 */

import 'dotenv/config';
import { Logger } from 'tslog';
import { KVManager } from './kv/KVManager.js';
import { RedisClient, StreamMessage } from './kv/RedisClient.js';
import { DuplicateIndex } from './DuplicateIndex.js';
import { APIServer } from './api/APIServer.js';

const logger = new Logger({ name: 'meta-dup' });

// Redis Streams for reliable event delivery from meta-core
const EVENTS_STREAM = 'file:events';
const CONSUMER_GROUP = 'meta-dup-consumer';

interface BatchUpdatePayload {
    timestamp: number;
    changes: Array<{
        action: 'add' | 'update' | 'remove';
        hashId: string;
    }>;
}

interface ResetPayload {
    timestamp: number;
    action: 'reset';
}

/**
 * Handle a stream message from Redis Streams
 * Routes messages by type to appropriate handlers
 *
 * Supports both:
 * - Direct file events from meta-core (add/change/delete/rename)
 * - Legacy batch events (for backward compatibility)
 */
async function handleStreamMessage(
    message: StreamMessage,
    duplicateIndex: DuplicateIndex,
    redisClient: RedisClient
): Promise<void> {
    try {
        switch (message.type) {
            // Direct file events from meta-core
            case 'add':
            case 'change': {
                // File added or changed - look up by path and update index
                // Note: We need to wait for meta-sort to process the file first
                // For now, just log - the duplicate index is rebuilt on startup
                logger.debug(`File ${message.type}: ${message.path}`);
                break;
            }

            case 'delete': {
                // File deleted - would need to find by path and remove
                logger.debug(`File deleted: ${message.path}`);
                break;
            }

            case 'rename': {
                // File renamed - treated as delete + add
                logger.debug(`File renamed: ${message.oldPath} -> ${message.path}`);
                break;
            }

            // Legacy batch events (for backward compatibility)
            case 'batch': {
                if (!message.payload) break;
                const batch: BatchUpdatePayload = JSON.parse(message.payload);
                logger.debug(`Processing batch update: ${batch.changes.length} changes`);

                for (const change of batch.changes) {
                    await duplicateIndex.onFileUpdate(change.hashId, change.action, redisClient);
                }
                break;
            }

            case 'reset': {
                if (!message.payload) break;
                const reset: ResetPayload = JSON.parse(message.payload);
                logger.info(`Processing reset event: ${reset.action}`);
                await duplicateIndex.rebuildFromRedis(redisClient);
                break;
            }

            case 'plugin:complete': {
                // Plugin completion events - update the file's metadata
                // This is when we get full hash for duplicate detection
                if (message.payload) {
                    try {
                        const payload = JSON.parse(message.payload);
                        if (payload.fileHash && payload.pluginId === 'fullhash') {
                            // Full hash plugin completed - this is when we can detect duplicates
                            await duplicateIndex.onFileUpdate(payload.fileHash, 'update', redisClient);
                        }
                    } catch {
                        // Ignore parse errors
                    }
                }
                break;
            }

            default:
                logger.warn(`Unknown stream message type: ${message.type}`);
        }
    } catch (error: any) {
        logger.error(`Error processing stream message ${message.id}:`, error.message);
        throw error; // Re-throw to prevent ACK
    }
}

async function main(): Promise<void> {
    logger.info('Starting meta-dup...');
    logger.info(`Node.js ${process.version}`);

    // Configuration
    const config = {
        metaCorePath: process.env.META_CORE_PATH ?? '/meta-core',
        filesPath: process.env.FILES_VOLUME ?? '/files',
        redisUrl: process.env.REDIS_URL,
        redisPrefix: process.env.REDIS_PREFIX ?? '',
        apiPort: parseInt(process.env.API_PORT ?? '3000', 10),
        apiHost: process.env.API_HOST ?? '0.0.0.0',
        baseUrl: process.env.BASE_URL,
        serviceVersion: process.env.SERVICE_VERSION ?? '1.0.0',
    };

    logger.info(`Config: META_CORE_PATH=${config.metaCorePath}`);

    // Initialize KV Manager (handles leader discovery)
    const kvManager = new KVManager({
        metaCorePath: config.metaCorePath,
        filesPath: config.filesPath,
        serviceName: 'meta-dup',
        apiPort: config.apiPort,
        baseUrl: config.baseUrl,
        redisPrefix: config.redisPrefix,
    });

    let redisClient: RedisClient | null = null;
    let duplicateIndex: DuplicateIndex | null = null;
    let apiServer: APIServer | null = null;

    // Graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
        logger.info(`Received ${signal}, shutting down...`);

        try {
            // Stop stream consumer first
            if (redisClient) {
                redisClient.stopStreamConsumer();
            }
            if (apiServer) await apiServer.stop();
            await kvManager.stop();
            logger.info('Shutdown complete');
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle ready event from KV manager
    kvManager.onReady(async () => {
        logger.info('KV Manager ready, initializing DuplicateIndex...');

        try {
            // Get Redis client from KV manager
            redisClient = kvManager.getClient();

            if (!redisClient) {
                logger.error('Redis client not available');
                return;
            }

            // Initialize DuplicateIndex
            duplicateIndex = new DuplicateIndex();

            // Rebuild index from all file:* keys in Redis
            logger.info('Building initial duplicate index from Redis...');
            await duplicateIndex.rebuildFromRedis(redisClient);

            // Initialize Redis Streams consumer
            logger.info(`Initializing stream consumer for ${EVENTS_STREAM}...`);
            await redisClient.initStreamConsumer(EVENTS_STREAM, CONSUMER_GROUP);

            // Process any pending entries from crashed consumers
            await redisClient.processPendingEntries(
                EVENTS_STREAM,
                CONSUMER_GROUP,
                30000, // 30 second idle threshold
                async (message: StreamMessage) => {
                    await handleStreamMessage(message, duplicateIndex!, redisClient!);
                }
            );

            // Start stream consumer in background
            logger.info('Starting stream consumer...');
            redisClient.startStreamConsumer(
                EVENTS_STREAM,
                CONSUMER_GROUP,
                async (message: StreamMessage) => {
                    await handleStreamMessage(message, duplicateIndex!, redisClient!);
                },
                5000 // 5 second block timeout
            ).catch(error => {
                logger.error('Stream consumer error:', error);
            });

            // Initialize API server
            apiServer = new APIServer(duplicateIndex, {
                port: config.apiPort,
                host: config.apiHost,
            }, kvManager);

            // Set Redis client for rebuild endpoint
            apiServer.setRedisClient(redisClient);

            // Start API server
            logger.info('Starting API server...');
            await apiServer.start();

            logger.info('meta-dup is ready!');
            logger.info(`API: http://${config.apiHost}:${config.apiPort}`);

            // Log initial stats
            const stats = duplicateIndex.getStats();
            logger.info(`Duplicates: ${stats.hashGroupCount} hash groups, ${stats.titleGroupCount} title groups`);
            logger.info(`Total files tracked: ${stats.totalFilesTracked}`);
        } catch (error) {
            logger.error('Failed to initialize after KV ready:', error);
        }
    });

    // Handle disconnect event
    kvManager.onDisconnect(() => {
        logger.warn('Redis disconnected, duplicate index will use cached data');
    });

    // Start KV Manager (initiates leader discovery)
    try {
        logger.info('Starting KV Manager...');
        await kvManager.start();

        // Wait for ready with timeout
        await kvManager.waitForReady(60000);
    } catch (error) {
        logger.error('Failed to start meta-dup:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
});
