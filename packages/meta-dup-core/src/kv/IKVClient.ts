/**
 * KV Client Interface - Read-only abstraction for meta-dup
 *
 * meta-dup is a FOLLOWER service that only reads metadata from Redis.
 * This interface provides the subset of operations needed for reading.
 */

export interface KeyValuePair {
    key: string;
    value: string;
}

export interface IKVClient {
    /**
     * Get a value by key (value is JSON deserialized)
     */
    get(key: string): Promise<any | null>;

    /**
     * Count keys with a given prefix
     */
    countKeysWithPrefix(prefix: string): Promise<number>;

    /**
     * Health check - verifies KV store is accessible
     */
    health(): Promise<boolean>;

    /**
     * Get all key-value pairs with a given prefix
     */
    getRange(prefix: string): Promise<KeyValuePair[]>;

    /**
     * Retrieve file metadata - reconstructs from individual property keys
     */
    getMetadataFlat(hashId: string): Promise<any | null>;

    /**
     * Get all unique hash IDs (files) stored in KV
     */
    getAllHashIds(): Promise<string[]>;

    /**
     * Subscribe to Redis pub/sub channel
     */
    subscribe(channel: string, callback: (message: string) => void): Promise<void>;

    /**
     * Unsubscribe from Redis pub/sub channel
     */
    unsubscribe(channel: string): Promise<void>;

    /**
     * Close connections and cleanup resources
     */
    close(): Promise<void>;
}

/**
 * Leader lock file content format (kv-leader.info)
 * Written by meta-core leader, read by other services
 */
export interface LeaderLockInfo {
    /** Hostname of the leader */
    hostname: string;

    /** Base URL for the leader service (e.g., http://localhost:8180) */
    baseUrl: string;

    /** meta-core API URL (port 9000) */
    apiUrl: string;

    /** Redis connection URL (e.g., redis://10.0.1.50:6379) */
    redisUrl: string;

    /** WebDAV URL for file access (external, via nginx/HTTPS) */
    webdavUrl: string;

    /** WebDAV URL for internal container-to-container access (direct to port 9000) */
    webdavUrlInternal: string;

    /** Timestamp when leadership was acquired */
    timestamp: number;

    /** Process ID of the leader */
    pid: number;
}

/**
 * Service registration info (simplified)
 * Full URLs are obtained via the /urls API endpoint
 */
export interface ServiceInfo {
    /** Service name (e.g., 'meta-sort', 'meta-fuse') */
    name: string;

    /** Hostname */
    hostname: string;

    /** Base URL for the service */
    baseUrl: string;

    /** Current status */
    status: 'running' | 'stale' | 'stopped';

    /** Last heartbeat timestamp (ISO string) */
    lastHeartbeat: string;

    /** Role for meta-core instances: 'leader', 'follower', or undefined for other services */
    role?: string;
}
