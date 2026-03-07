/**
 * KV Manager for meta-dup (FOLLOWER-only)
 *
 * Simplified KV manager that:
 * 1. Discovers the leader via LeaderClient (reads kv-leader.info)
 * 2. Creates Redis client connection
 * 3. Handles reconnection on leader failure
 *
 * Unlike meta-sort's KVManager, this version never spawns Redis -
 * it only connects as a client. Leader election is handled by meta-core.
 */

import { hostname } from 'os';
import { Logger } from 'tslog';
import { LeaderClient } from './LeaderClient.js';
import { ServiceRegistration } from './ServiceRegistration.js';
import { RedisClient } from './RedisClient.js';
import type { LeaderLockInfo } from './IKVClient.js';

const logger = new Logger({ name: 'KVManager' });

interface KVManagerConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** Path to FILES_VOLUME (e.g., /files) */
    filesPath: string;

    /** Service name (for logging) */
    serviceName?: string;

    /** HTTP API port */
    apiPort?: number;

    /** Override Redis URL (skip leader discovery if provided) */
    redisUrl?: string;

    /** Redis key prefix (default: 'meta-sort:') */
    redisPrefix?: string;

    /** Base URL for service discovery (overrides auto-detected URL) */
    baseUrl?: string;

    /** meta-core API URL (e.g., http://localhost:9000) */
    metaCoreUrl?: string;
}

export class KVManager {
    private config: Required<KVManagerConfig>;
    private leaderClient: LeaderClient | null = null;
    private serviceRegistration: ServiceRegistration | null = null;
    private redisClient: RedisClient | null = null;
    private isStarted = false;
    private isShuttingDown = false;

    // Event callbacks
    private onReadyCallbacks: (() => void)[] = [];
    private onDisconnectCallbacks: (() => void)[] = [];

    constructor(config: KVManagerConfig) {
        this.config = {
            serviceName: 'meta-dup',
            apiPort: 3000,
            redisUrl: '',
            redisPrefix: '',
            baseUrl: '',
            metaCoreUrl: '',
            ...config
        };
    }

    /**
     * Start the KV manager
     */
    async start(): Promise<void> {
        if (this.isStarted) {
            logger.warn('KVManager already started');
            return;
        }

        logger.info(`Starting KVManager for ${this.config.serviceName}...`);

        // Initialize and start service registration for heartbeat
        const apiUrl = this.config.baseUrl || `http://${hostname()}:${this.config.apiPort}`;
        this.serviceRegistration = new ServiceRegistration({
            metaCorePath: this.config.metaCorePath,
            serviceName: this.config.serviceName,
            apiUrl
        });
        await this.serviceRegistration.start();

        // If direct Redis URL provided, skip leader discovery
        if (this.config.redisUrl) {
            logger.info(`Using direct Redis URL: ${this.config.redisUrl}`);
            await this.connectToRedis(this.config.redisUrl);
            this.isStarted = true;
            return;
        }

        // Use leader client
        this.leaderClient = new LeaderClient({
            metaCorePath: this.config.metaCorePath,
            metaCoreUrl: this.config.metaCoreUrl || undefined
        });

        // Set up leader change callback
        this.leaderClient.onChange(async () => {
            logger.info('Leader changed, reconnecting...');
            await this.reconnect();
        });

        // Wait for leader and connect
        try {
            const leaderInfo = await this.leaderClient.waitForLeader(30000);
            logger.info(`Connecting to Redis at ${leaderInfo.redisUrl}...`);
            await this.connectToRedis(leaderInfo.redisUrl);
        } catch (error: any) {
            logger.error(`Failed to connect to leader: ${error.message}`);
            throw error;
        }

        // Start watching for leader changes
        this.leaderClient.startWatching();

        this.isStarted = true;
    }

    /**
     * Reconnect to Redis after leader change
     */
    private async reconnect(): Promise<void> {
        if (this.isShuttingDown || !this.leaderClient) {
            return;
        }

        // Disconnect existing
        await this.disconnectRedis();
        this.notifyDisconnect();

        // Wait for new leader and connect
        try {
            const leaderInfo = await this.leaderClient.waitForLeader(30000);
            logger.info(`Reconnecting to Redis at ${leaderInfo.redisUrl}...`);
            await this.connectToRedis(leaderInfo.redisUrl);
        } catch (error: any) {
            logger.error(`Failed to reconnect: ${error.message}`);
        }
    }

    /**
     * Stop the KV manager
     */
    async stop(): Promise<void> {
        if (!this.isStarted) return;

        logger.info('Stopping KVManager...');
        this.isShuttingDown = true;

        // Stop leader client
        if (this.leaderClient) {
            this.leaderClient.close();
            this.leaderClient = null;
        }

        // Stop service registration (if it was started)
        if (this.serviceRegistration) {
            await this.serviceRegistration.stop();
            this.serviceRegistration = null;
        }

        // Disconnect Redis
        await this.disconnectRedis();

        this.isStarted = false;
        logger.info('KVManager stopped');
    }

    /**
     * Connect to Redis
     */
    private async connectToRedis(url: string): Promise<void> {
        try {
            // Disconnect existing client if any
            await this.disconnectRedis();

            // Create new client
            this.redisClient = new RedisClient({
                url,
                prefix: this.config.redisPrefix,
                filesVolume: this.config.filesPath
            });

            await this.redisClient.connect();
            logger.info('Connected to Redis');

            // Notify ready
            this.notifyReady();
        } catch (error: any) {
            logger.error(`Failed to connect to Redis: ${error.message}`);
            this.redisClient = null;
        }
    }

    /**
     * Disconnect from Redis
     */
    private async disconnectRedis(): Promise<void> {
        if (this.redisClient) {
            try {
                await this.redisClient.disconnect();
            } catch (error: any) {
                logger.warn(`Error disconnecting Redis: ${error.message}`);
            }
            this.redisClient = null;
        }
    }

    /**
     * Notify ready callbacks
     */
    private notifyReady(): void {
        for (const callback of this.onReadyCallbacks) {
            try {
                callback();
            } catch (error: any) {
                logger.error(`Error in ready callback: ${error.message}`);
            }
        }
    }

    /**
     * Notify disconnect callbacks
     */
    private notifyDisconnect(): void {
        for (const callback of this.onDisconnectCallbacks) {
            try {
                callback();
            } catch (error: any) {
                logger.error(`Error in disconnect callback: ${error.message}`);
            }
        }
    }

    // ========================================================================
    // Event Registration
    // ========================================================================

    /**
     * Register callback for when KV client is ready
     */
    onReady(callback: () => void): this {
        this.onReadyCallbacks.push(callback);

        // If already ready, call immediately
        if (this.redisClient?.connected) {
            callback();
        }

        return this;
    }

    /**
     * Register callback for disconnection
     */
    onDisconnect(callback: () => void): this {
        this.onDisconnectCallbacks.push(callback);
        return this;
    }

    /**
     * Wait for KV client to be ready
     */
    async waitForReady(timeoutMs: number = 30000): Promise<void> {
        if (this.redisClient?.connected) return;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`KV client not ready after ${timeoutMs}ms`));
            }, timeoutMs);

            this.onReady(() => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    // ========================================================================
    // Getters
    // ========================================================================

    /**
     * Get the Redis client (may be null if not connected)
     */
    getClient(): RedisClient | null {
        return this.redisClient;
    }

    /**
     * Get the Redis client (throws if not connected)
     */
    requireClient(): RedisClient {
        if (!this.redisClient) {
            throw new Error('Redis client not available. Ensure start() was called and leader is available.');
        }
        return this.redisClient;
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.redisClient?.connected ?? false;
    }

    /**
     * Health check
     */
    async isHealthy(): Promise<boolean> {
        if (!this.redisClient) return false;
        try {
            const stats = await this.redisClient.getStats();
            return stats.connected;
        } catch {
            return false;
        }
    }

    /**
     * Get leader info
     */
    getLeaderInfo(): LeaderLockInfo | null {
        return this.leaderClient?.getCachedLeaderInfo() ?? null;
    }

    /**
     * Get leader client
     */
    getLeaderClient(): LeaderClient | null {
        return this.leaderClient;
    }

    /**
     * Get service registration instance
     */
    getServiceRegistration(): ServiceRegistration | null {
        return this.serviceRegistration;
    }

    /**
     * Get configured paths
     */
    getPaths() {
        return {
            metaCorePath: this.config.metaCorePath,
            filesPath: this.config.filesPath
        };
    }
}
