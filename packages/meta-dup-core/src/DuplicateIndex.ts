/**
 * DuplicateIndex - Core duplicate detection logic
 *
 * Maintains in-memory indexes for:
 * - Hash duplicates: files with the same SHA-256 hash (exact copies)
 * - Title duplicates: files with the same parsed title (different releases)
 *
 * Updates in real-time via Redis Streams events from meta-sort.
 */

import { Logger } from 'tslog';
import type { FileMetadata, RedisClient } from './kv/RedisClient.js';

const logger = new Logger({ name: 'DuplicateIndex' });

/**
 * Information about a file in a duplicate group
 */
export interface FileInfo {
    hashId: string;
    filePath: string;
    title?: string;
    sha256?: string;
    sizeByte?: number;
    year?: number;
    season?: number;
    episode?: number;
    fileType?: string;
}

/**
 * A group of duplicate files sharing the same key (hash or title)
 */
export interface DuplicateGroup {
    key: string;           // hash or title
    files: FileInfo[];     // Array of file info
}

/**
 * Statistics about duplicate detection
 */
export interface DuplicateStats {
    hashGroupCount: number;
    hashFileCount: number;
    titleGroupCount: number;
    titleFileCount: number;
    totalFilesTracked: number;
    lastUpdated: string;
}

/**
 * Full duplicate data response
 */
export interface DuplicateData {
    hashDuplicates: DuplicateGroup[];
    titleDuplicates: DuplicateGroup[];
    stats: DuplicateStats;
    computedAt: string;
}

export class DuplicateIndex {
    // Primary indexes: key -> Set of hashIds
    private byHash: Map<string, Set<string>> = new Map();
    private byTitle: Map<string, Set<string>> = new Map();

    // Track paths by midhash256 (for hash duplicates from events)
    // This detects duplicates directly from the event stream without Redis lookup
    private pathsByMidHash: Map<string, Set<string>> = new Map();

    // File info storage: hashId -> FileInfo
    private fileInfo: Map<string, FileInfo> = new Map();

    // Track when last updated
    private lastUpdated: Date = new Date();

    constructor() {
        logger.info('DuplicateIndex initialized');
    }

    /**
     * Add a path to the midhash tracking (for hash duplicates from events)
     */
    addPath(midhash256: string, path: string): void {
        const pathSet = this.pathsByMidHash.get(midhash256) ?? new Set();
        pathSet.add(path);
        this.pathsByMidHash.set(midhash256, pathSet);
        this.lastUpdated = new Date();

        if (pathSet.size > 1) {
            logger.info(`Hash duplicate detected: ${midhash256} has ${pathSet.size} paths`);
        }
    }

    /**
     * Remove a path from the midhash tracking
     */
    removePath(midhash256: string, path: string): void {
        const pathSet = this.pathsByMidHash.get(midhash256);
        if (pathSet) {
            pathSet.delete(path);
            if (pathSet.size === 0) {
                this.pathsByMidHash.delete(midhash256);
            }
            this.lastUpdated = new Date();
        }
    }

    /**
     * Add or update a file in the index
     */
    addFile(hashId: string, metadata: FileMetadata): void {
        // First remove any existing entry to ensure clean state
        this.removeFile(hashId);

        // Extract relevant info
        const info: FileInfo = {
            hashId,
            filePath: metadata.originalPath || metadata.sourcePath,
            title: this.extractTitle(metadata),
            sha256: metadata.sha256,
            sizeByte: metadata.size,
            year: metadata.year || metadata.movieYear,
            season: metadata.season,
            episode: metadata.episode,
            fileType: metadata.fileType,
        };

        // Store file info
        this.fileInfo.set(hashId, info);

        // Index by SHA-256 hash (if available)
        if (info.sha256) {
            const hashSet = this.byHash.get(info.sha256) ?? new Set();
            hashSet.add(hashId);
            this.byHash.set(info.sha256, hashSet);
        }

        // Index by title (if available)
        const titleKey = this.getTitleKey(metadata);
        if (titleKey) {
            const titleSet = this.byTitle.get(titleKey) ?? new Set();
            titleSet.add(hashId);
            this.byTitle.set(titleKey, titleSet);
        }

        this.lastUpdated = new Date();
    }

    /**
     * Remove a file from the index
     */
    removeFile(hashId: string): void {
        const info = this.fileInfo.get(hashId);
        if (!info) return;

        // Remove from hash index
        if (info.sha256) {
            const hashSet = this.byHash.get(info.sha256);
            if (hashSet) {
                hashSet.delete(hashId);
                if (hashSet.size === 0) {
                    this.byHash.delete(info.sha256);
                }
            }
        }

        // Remove from title index
        if (info.title) {
            const titleKey = info.title.toLowerCase();
            const titleSet = this.byTitle.get(titleKey);
            if (titleSet) {
                titleSet.delete(hashId);
                if (titleSet.size === 0) {
                    this.byTitle.delete(titleKey);
                }
            }
        }

        // Remove file info
        this.fileInfo.delete(hashId);
        this.lastUpdated = new Date();
    }

    /**
     * Extract title from metadata for duplicate detection
     */
    private extractTitle(metadata: FileMetadata): string | undefined {
        // Prefer parsed title over filename
        if (metadata.title) {
            return metadata.title;
        }
        if (metadata.titles?.eng) {
            return metadata.titles.eng;
        }
        if (metadata.originalTitle) {
            return metadata.originalTitle;
        }
        return undefined;
    }

    /**
     * Get normalized title key for indexing
     * Includes year, season, episode for more precise matching
     */
    private getTitleKey(metadata: FileMetadata): string | null {
        const title = this.extractTitle(metadata);
        if (!title) return null;

        // Build a normalized key
        let key = title.toLowerCase().trim();

        // Add year if available (for movies)
        if (metadata.year || metadata.movieYear) {
            key += `:${metadata.year || metadata.movieYear}`;
        }

        // Add season/episode if available (for TV shows)
        if (metadata.season !== undefined) {
            key += `:s${metadata.season}`;
        }
        if (metadata.episode !== undefined) {
            key += `:e${metadata.episode}`;
        }

        return key;
    }

    /**
     * Get path-based duplicates (files with same midhash256 from events)
     * These are detected directly from the event stream without Redis lookup
     */
    getPathDuplicates(): DuplicateGroup[] {
        const groups: DuplicateGroup[] = [];

        for (const [midhash256, paths] of this.pathsByMidHash) {
            if (paths.size > 1) {
                // Create FileInfo objects with just the path (minimal info from events)
                const files: FileInfo[] = Array.from(paths).map(path => ({
                    hashId: midhash256,
                    filePath: path,
                }));
                groups.push({
                    key: midhash256,
                    files: files.sort((a, b) => a.filePath.localeCompare(b.filePath)),
                });
            }
        }

        // Sort by number of duplicates (descending)
        return groups.sort((a, b) => b.files.length - a.files.length);
    }

    /**
     * Get all hash-based duplicates (combines path-based midhash256 and SHA-256 duplicates)
     * Path duplicates are detected from events, SHA-256 duplicates from fullhash plugin
     */
    getHashDuplicates(): DuplicateGroup[] {
        const groups: DuplicateGroup[] = [];
        const seenKeys = new Set<string>();

        // First, add path-based duplicates (from events, using midhash256)
        for (const [midhash256, paths] of this.pathsByMidHash) {
            if (paths.size > 1) {
                seenKeys.add(midhash256);
                const files: FileInfo[] = Array.from(paths).map(path => ({
                    hashId: midhash256,
                    filePath: path,
                }));
                groups.push({
                    key: midhash256,
                    files: files.sort((a, b) => a.filePath.localeCompare(b.filePath)),
                });
            }
        }

        // Then, add SHA-256 duplicates (from fullhash plugin)
        // Only add if not already covered by path duplicates
        for (const [hash, hashIds] of this.byHash) {
            if (hashIds.size > 1 && !seenKeys.has(hash)) {
                const files = this.getFileInfos(hashIds);
                groups.push({
                    key: hash,
                    files: files.sort((a, b) => a.filePath.localeCompare(b.filePath)),
                });
            }
        }

        // Sort by number of duplicates (descending)
        return groups.sort((a, b) => b.files.length - a.files.length);
    }

    /**
     * Get all title-based duplicates (files with same parsed title)
     */
    getTitleDuplicates(): DuplicateGroup[] {
        const groups: DuplicateGroup[] = [];

        for (const [title, hashIds] of this.byTitle) {
            if (hashIds.size > 1) {
                const files = this.getFileInfos(hashIds);
                groups.push({
                    key: title,
                    files: files.sort((a, b) => a.filePath.localeCompare(b.filePath)),
                });
            }
        }

        // Sort by number of duplicates (descending)
        return groups.sort((a, b) => b.files.length - a.files.length);
    }

    /**
     * Get FileInfo for a set of hashIds
     */
    private getFileInfos(hashIds: Set<string>): FileInfo[] {
        const files: FileInfo[] = [];
        for (const hashId of hashIds) {
            const info = this.fileInfo.get(hashId);
            if (info) {
                files.push(info);
            }
        }
        return files;
    }

    /**
     * Get statistics about duplicates
     */
    getStats(): DuplicateStats {
        const hashDuplicates = this.getHashDuplicates();
        const titleDuplicates = this.getTitleDuplicates();
        const pathDuplicates = this.getPathDuplicates();

        // Count unique paths tracked in pathsByMidHash
        let pathsTracked = 0;
        for (const paths of this.pathsByMidHash.values()) {
            pathsTracked += paths.size;
        }

        return {
            hashGroupCount: hashDuplicates.length,
            hashFileCount: hashDuplicates.reduce((sum, g) => sum + g.files.length, 0),
            titleGroupCount: titleDuplicates.length,
            titleFileCount: titleDuplicates.reduce((sum, g) => sum + g.files.length, 0),
            totalFilesTracked: Math.max(this.fileInfo.size, pathsTracked),
            lastUpdated: this.lastUpdated.toISOString(),
        };
    }

    /**
     * Get full duplicate data
     */
    getDuplicateData(): DuplicateData {
        return {
            hashDuplicates: this.getHashDuplicates(),
            titleDuplicates: this.getTitleDuplicates(),
            stats: this.getStats(),
            computedAt: new Date().toISOString(),
        };
    }

    /**
     * Clear all indexes
     */
    clear(): void {
        this.byHash.clear();
        this.byTitle.clear();
        this.pathsByMidHash.clear();
        this.fileInfo.clear();
        this.lastUpdated = new Date();
        logger.info('DuplicateIndex cleared');
    }

    /**
     * Rebuild index from all files in Redis
     */
    async rebuildFromRedis(redisClient: RedisClient): Promise<void> {
        logger.info('Rebuilding DuplicateIndex from Redis...');

        // Clear existing data
        this.clear();

        // Load all files from Redis
        const files = await redisClient.getAllFiles();

        logger.info(`Loading ${files.size} files into DuplicateIndex...`);

        // Add each file to the index
        for (const [hashId, metadata] of files) {
            this.addFile(hashId, metadata);
        }

        const stats = this.getStats();
        logger.info(`DuplicateIndex rebuilt: ${stats.totalFilesTracked} files, ` +
            `${stats.hashGroupCount} hash duplicates, ${stats.titleGroupCount} title duplicates`);
    }

    /**
     * Handle file update from Redis
     */
    async onFileUpdate(
        hashId: string,
        action: 'add' | 'update' | 'remove',
        redisClient: RedisClient
    ): Promise<void> {
        if (action === 'remove') {
            this.removeFile(hashId);
            logger.debug(`Removed file ${hashId} from index`);
        } else {
            // add or update - fetch latest metadata from Redis
            const metadata = await redisClient.getFileByHashId(hashId);
            if (metadata) {
                this.addFile(hashId, metadata);
                logger.debug(`${action === 'add' ? 'Added' : 'Updated'} file ${hashId} in index`);
            }
        }
    }

    /**
     * Update title index for a specific file when metadata changes
     * Called by MetaEventConsumer when title-related fields are updated
     */
    async updateTitleForFile(hashId: string, redisClient: RedisClient): Promise<void> {
        const currentInfo = this.fileInfo.get(hashId);
        const oldTitleKey = currentInfo ? this.getTitleKeyFromInfo(currentInfo) : null;

        // Fetch updated metadata from Redis
        const metadata = await redisClient.getFileByHashId(hashId);

        if (!metadata) {
            // File deleted - remove from title index
            if (oldTitleKey) {
                this.removeFromTitleIndex(hashId, oldTitleKey);
                logger.debug(`Removed deleted file ${hashId} from title index`);
            }
            return;
        }

        const newTitleKey = this.getTitleKey(metadata);

        // Only update if title key changed
        if (oldTitleKey !== newTitleKey) {
            if (oldTitleKey) {
                this.removeFromTitleIndex(hashId, oldTitleKey);
            }
            if (newTitleKey) {
                this.addToTitleIndex(hashId, newTitleKey);
            }
            // Update cached file info
            this.addFile(hashId, metadata);
            logger.debug(`Title updated for ${hashId}: "${oldTitleKey}" -> "${newTitleKey}"`);
        }

        this.lastUpdated = new Date();
    }

    /**
     * Get normalized title key from FileInfo
     */
    private getTitleKeyFromInfo(info: FileInfo): string | null {
        if (!info.title) return null;

        let key = info.title.toLowerCase().trim();

        if (info.year) {
            key += `:${info.year}`;
        }
        if (info.season !== undefined) {
            key += `:s${info.season}`;
        }
        if (info.episode !== undefined) {
            key += `:e${info.episode}`;
        }

        return key;
    }

    /**
     * Remove a file from the title index by key
     */
    private removeFromTitleIndex(hashId: string, titleKey: string): void {
        const titleSet = this.byTitle.get(titleKey);
        if (titleSet) {
            titleSet.delete(hashId);
            if (titleSet.size === 0) {
                this.byTitle.delete(titleKey);
            }
        }
    }

    /**
     * Add a file to the title index by key
     */
    private addToTitleIndex(hashId: string, titleKey: string): void {
        const titleSet = this.byTitle.get(titleKey) ?? new Set();
        titleSet.add(hashId);
        this.byTitle.set(titleKey, titleSet);
    }
}
