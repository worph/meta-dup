/**
 * LeaderClient - locates meta-core and exposes its URLs.
 *
 * Since meta-discovery v1 this is a thin adapter over MetaCoreLocator
 * (../discovery/meshdisco.js): meta-core is found by UDP announce instead of by
 * reading /meta-core/locks/kv-leader.info, which means this service no longer
 * needs the /meta-core volume mounted at all.
 *
 * The public surface is deliberately unchanged so KVManager and its callers did
 * not have to move: getLeaderInfo / getUrls / getApiUrl / getWebdavUrl*,
 * waitForLeader (same 30s default), startWatching / onChange (the fs.watch on
 * the lock dir became "an announce arrived carrying a different apiUrl").
 *
 * Precedence is the pin: when metaCoreUrl (META_CORE_URL) is set it always
 * wins and the wire is never consulted for core selection. See
 * docs/project-architecture/service-discovery.md.
 *
 * The name "leader" is legacy: meta-core's flock election is vestigial, and
 * redisUrl has been empty since the api-mediated-access lockdown.
 */

import { Logger } from 'tslog';
import { MetaCoreLocator, type MeshNeighbor } from '../discovery/meshdisco.js';
import type { LeaderLockInfo } from './IKVClient.js';

const logger = new Logger({ name: 'LeaderClient' });

export interface LeaderClientConfig {
    /**
     * @deprecated Unused since meta-discovery v1. Kept so existing callers
     * compile unchanged; nothing reads the volume any more.
     */
    metaCorePath?: string;

    /** meta-core API URL. When set, discovery never overrides it. */
    metaCoreUrl?: string;

    /** This service's name, used for its own announce. */
    serviceName?: string;

    /** Browser-facing URL announced for the nav menu. */
    baseUrl?: string;

    /** Service version, display only. */
    version?: string;
}

export interface URLsResponse {
    hostname: string;
    baseUrl: string;
    apiUrl: string;
    redisUrl: string;
    webdavUrl: string;
    webdavUrlInternal: string;
    isLeader: boolean;
}

export class LeaderClient {
    private config: LeaderClientConfig;
    private locator: MetaCoreLocator;
    private leaderInfo: LeaderLockInfo | null = null;
    private onChangeCallbacks: (() => void)[] = [];
    private started = false;

    // Only used on the pinned path, where URLs still come from GET /urls.
    // A discovered core carries them in the announce itself.
    private cachedUrls: URLsResponse | null = null;
    private urlsCacheTime: number = 0;
    private readonly urlsCacheTTL: number = 5000;

    constructor(config: LeaderClientConfig) {
        this.config = config;
        this.locator = new MetaCoreLocator({
            serviceName: config.serviceName ?? 'meta-dup',
            baseUrl: config.baseUrl,
            version: config.version,
            metaCoreUrl: config.metaCoreUrl,
            enabled: process.env.ENABLE_UDP_DISCOVERY !== 'false' &&
                process.env.ENABLE_UDP_DISCOVERY !== '0',
        });
        this.locator.onChange(() => {
            this.cachedUrls = null;
            this.urlsCacheTime = 0;
            this.notifyChange();
        });
    }

    private async ensureStarted(): Promise<void> {
        if (this.started) return;
        this.started = true;
        await this.locator.start();
    }

    /**
     * Guard against a rollback reintroducing direct Redis exposure.
     * api-mediated-access PR D removed redisUrl; ALLOW_LEGACY_REDIS_URL=1
     * downgrades this to a warning during a deliberate temporary rollback.
     */
    private assertNoRedisUrl(redisUrl: string | undefined): void {
        if (!redisUrl) return;
        const msg =
            'meta-core still publishes redisUrl; direct Redis access was retired ' +
            'by the api-mediated-access lockdown. Verify meta-core version.';
        if (process.env.ALLOW_LEGACY_REDIS_URL === '1') {
            logger.warn('WARNING: ' + msg);
        } else {
            throw new Error(msg);
        }
    }

    private async fetchUrls(apiUrl: string): Promise<URLsResponse | null> {
        const now = Date.now();
        if (this.cachedUrls && (now - this.urlsCacheTime) < this.urlsCacheTTL) {
            return this.cachedUrls;
        }
        try {
            const response = await fetch(`${apiUrl}/urls`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) {
                logger.error(`Failed to fetch URLs: ${response.status} ${response.statusText}`);
                return null;
            }
            const parsed = await response.json() as URLsResponse;
            this.assertNoRedisUrl(parsed.redisUrl);
            this.cachedUrls = parsed;
            this.urlsCacheTime = now;
            return this.cachedUrls;
        } catch (error: any) {
            logger.error(`Error calling /urls API: ${error.message}`);
            return null;
        }
    }

    /**
     * Resolve meta-core's URLs — straight from the announce when discovered
     * (no HTTP hop needed), or over HTTP when pinned.
     */
    async getUrls(): Promise<URLsResponse | null> {
        await this.ensureStarted();

        const wire = this.locator.getUrls();
        if (wire && !this.config.metaCoreUrl) {
            return {
                hostname: wire.hostname,
                baseUrl: wire.baseUrl,
                apiUrl: wire.apiUrl,
                redisUrl: '',
                webdavUrl: wire.webdavUrl,
                webdavUrlInternal: wire.webdavUrlInternal,
                isLeader: true,
            };
        }

        const apiUrl = this.locator.getApiUrl();
        if (!apiUrl) {
            logger.error('No meta-core API URL available');
            return null;
        }
        return this.fetchUrls(apiUrl);
    }

    async getLeaderInfo(): Promise<LeaderLockInfo | null> {
        try {
            const urls = await this.getUrls();
            if (!urls) return null;
            this.leaderInfo = {
                hostname: urls.hostname,
                baseUrl: urls.baseUrl,
                apiUrl: urls.apiUrl,
                redisUrl: urls.redisUrl,
                webdavUrl: urls.webdavUrl,
                webdavUrlInternal: urls.webdavUrlInternal,
                timestamp: Date.now(),
                pid: 0
            };
            return this.leaderInfo;
        } catch (error: any) {
            logger.error(`Failed to read leader info: ${error.message}`);
            return null;
        }
    }

    async getRedisUrl(): Promise<string | null> {
        return (await this.getLeaderInfo())?.redisUrl ?? null;
    }

    async getWebdavUrl(): Promise<string | null> {
        return (await this.getLeaderInfo())?.webdavUrl ?? null;
    }

    /** Internal WebDAV URL — use for container-to-container access. */
    async getWebdavUrlInternal(): Promise<string | null> {
        return (await this.getLeaderInfo())?.webdavUrlInternal ?? null;
    }

    async getApiUrl(): Promise<string | null> {
        return (await this.getLeaderInfo())?.apiUrl ?? null;
    }

    /**
     * Block until meta-core is reachable. Probes immediately then every 500ms,
     * matching the previous file-polling loop's timing exactly.
     */
    async waitForLeader(timeoutMs: number = 30000): Promise<LeaderLockInfo> {
        await this.ensureStarted();
        const deadline = Date.now() + timeoutMs;

        await this.locator.waitForCore(timeoutMs);

        while (Date.now() < deadline) {
            const info = await this.getLeaderInfo();
            if (info) {
                logger.info(`meta-core found: ${info.hostname} at ${info.apiUrl}`);
                return info;
            }
            logger.debug('Waiting for meta-core...');
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error(`No meta-core found within ${timeoutMs}ms`);
    }

    /**
     * Previously an fs.watch on the lock directory. Discovery is always
     * listening, so this only has to make sure the node is running.
     */
    startWatching(): void {
        void this.ensureStarted();
    }

    stopWatching(): void {
        // No-op: the locator keeps listening until close().
    }

    onChange(callback: () => void): this {
        this.onChangeCallbacks.push(callback);
        return this;
    }

    private notifyChange(): void {
        logger.debug('meta-core changed, invalidating cache...');
        for (const callback of this.onChangeCallbacks) {
            try {
                callback();
            } catch (error: any) {
                logger.error(`Error in change callback: ${error.message}`);
            }
        }
    }

    getCachedLeaderInfo(): LeaderLockInfo | null {
        return this.leaderInfo;
    }

    /** Neighbours for the nav menu (one row per service name). */
    getNeighbors(): MeshNeighbor[] {
        return this.locator.getNeighbors();
    }

    /** This service's own announce, so the menu can show itself. */
    self(): MeshNeighbor {
        return this.locator.self();
    }

    close(): void {
        this.onChangeCallbacks = [];
        void this.locator.stop();
        this.started = false;
    }
}
