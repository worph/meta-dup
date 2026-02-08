/**
 * MetaEventConsumer - Consumes meta:events stream for title updates
 *
 * meta-core publishes metadata changes to the meta:events stream via MetaPublisher.
 * This consumer listens for title-related field changes and updates the DuplicateIndex
 * to keep title duplicate detection current as plugins like TMDB update metadata.
 *
 * Event format from meta-core:
 * {type: "set"|"del", key: "file:{hashId}/{field}", ts: ...}
 */

import { Redis } from 'ioredis';
import { Logger } from 'tslog';

const logger = new Logger({ name: 'MetaEventConsumer' });

const META_EVENTS_STREAM = 'meta:events';
const CONSUMER_GROUP = 'meta-dup-meta-consumer';

// Fields that affect title duplicate detection
const TITLE_FIELDS = [
    'title', 'titles/eng', 'originalTitle', 'fileName',
    'year', 'movieYear', 'season', 'episode', 'tmdb'
];

// Debounce time in ms for rapid updates (multiple fields updated at once)
const DEBOUNCE_MS = 500;

export class MetaEventConsumer {
    private redis: Redis;
    private consumerName: string;
    private running = false;
    private pendingUpdates: Map<string, NodeJS.Timeout> = new Map();
    private onTitleChange: (hashId: string) => Promise<void>;

    constructor(
        redis: Redis,
        consumerName: string,
        onTitleChange: (hashId: string) => Promise<void>
    ) {
        this.redis = redis;
        this.consumerName = consumerName;
        this.onTitleChange = onTitleChange;
    }

    /**
     * Start consuming meta:events stream
     */
    async start(): Promise<void> {
        if (this.running) {
            return;
        }

        // Create consumer group at '$' (only new messages)
        // We don't need historical events - the initial rebuild already loaded all titles
        try {
            await this.redis.xgroup('CREATE', META_EVENTS_STREAM, CONSUMER_GROUP, '$', 'MKSTREAM');
            logger.info(`Created consumer group '${CONSUMER_GROUP}'`);
        } catch (error: any) {
            if (error.message?.includes('BUSYGROUP')) {
                logger.debug(`Consumer group '${CONSUMER_GROUP}' already exists`);
            } else {
                throw error;
            }
        }

        this.running = true;
        logger.info(`Starting meta:events consumer (consumer: ${this.consumerName})`);

        // Start consume loop
        this.consumeLoop().catch(error => {
            if (this.running) {
                logger.error('meta:events consumer loop error:', error);
            }
        });
    }

    /**
     * Stop the consumer
     */
    stop(): void {
        if (!this.running) {
            return;
        }

        logger.info('Stopping meta:events consumer...');
        this.running = false;

        // Clear pending debounced updates
        for (const timeout of this.pendingUpdates.values()) {
            clearTimeout(timeout);
        }
        this.pendingUpdates.clear();
    }

    /**
     * Main consume loop - reads from stream and processes messages
     */
    private async consumeLoop(): Promise<void> {
        while (this.running) {
            try {
                // XREADGROUP with 5s block timeout
                const result = await this.redis.call(
                    'XREADGROUP',
                    'GROUP', CONSUMER_GROUP,
                    this.consumerName,
                    'BLOCK', 5000,
                    'COUNT', 100,
                    'STREAMS', META_EVENTS_STREAM,
                    '>'
                ) as Array<[string, Array<[string, string[]]>]> | null;

                if (!result || result.length === 0) {
                    continue;
                }

                // Process each stream's messages
                for (const [streamName, entries] of result) {
                    for (const [id, fields] of entries) {
                        try {
                            await this.processMessage(id, fields);
                            // ACK after successful processing
                            await this.redis.xack(META_EVENTS_STREAM, CONSUMER_GROUP, id);
                        } catch (error: any) {
                            logger.error(`Error processing meta event ${id}:`, error.message);
                            // Still ACK to prevent blocking on bad messages
                            await this.redis.xack(META_EVENTS_STREAM, CONSUMER_GROUP, id);
                        }
                    }
                }
            } catch (error: any) {
                if (!this.running) {
                    break;
                }
                logger.error('Error reading meta:events:', error.message);
                // Brief pause before retrying
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        logger.info('meta:events consumer stopped');
    }

    /**
     * Process a single message from the stream
     */
    private async processMessage(id: string, fields: string[]): Promise<void> {
        // Parse fields array into map
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
        }

        const type = fieldMap.type;
        const key = fieldMap.key;

        if (!type || !key) {
            return;
        }

        // Only care about 'set' events (new/updated values)
        if (type !== 'set') {
            return;
        }

        // Check if this is a title-related field
        if (!this.isTitleField(key)) {
            return;
        }

        // Extract hashId from key format: file:{hashId}/{field}
        const hashId = this.extractHashId(key);
        if (!hashId) {
            return;
        }

        logger.debug(`Title field changed: ${key}`);

        // Debounce: multiple fields may be updated at once (e.g., title + year from TMDB)
        // Wait a short time to batch updates for the same file
        this.debounceUpdate(hashId);
    }

    /**
     * Check if a key represents a title-related field
     */
    private isTitleField(key: string): boolean {
        return TITLE_FIELDS.some(field => key.endsWith(`/${field}`));
    }

    /**
     * Extract hashId from key format: file:{hashId}/{field}
     */
    private extractHashId(key: string): string | null {
        const match = key.match(/^file:([^/]+)\//);
        return match ? match[1] : null;
    }

    /**
     * Debounce updates for the same file
     */
    private debounceUpdate(hashId: string): void {
        // Clear existing timeout if any
        const existing = this.pendingUpdates.get(hashId);
        if (existing) {
            clearTimeout(existing);
        }

        // Set new timeout
        const timeout = setTimeout(async () => {
            this.pendingUpdates.delete(hashId);
            try {
                await this.onTitleChange(hashId);
            } catch (error: any) {
                logger.error(`Error updating title for ${hashId}:`, error.message);
            }
        }, DEBOUNCE_MS);

        this.pendingUpdates.set(hashId, timeout);
    }
}
