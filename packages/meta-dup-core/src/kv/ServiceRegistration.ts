/**
 * Service Registration using shared filesystem
 *
 * Each service registers itself in /meta-core/services/{service-name}-{hostname}.json
 * with its base URL, status, and heartbeat timestamp.
 *
 * Service discovery is centralized in meta-core - this class only handles registration.
 * For service discovery, use the /api/services endpoint (proxied to meta-core via nginx).
 *
 * Each service must call start() to register itself and begin heartbeat updates.
 * meta-core runs a cleanup process that removes services with stale heartbeats.
 */

import { promises as fs } from 'fs';
import { hostname } from 'os';
import { Logger } from 'tslog';
import type { ServiceInfo } from './IKVClient.js';

const logger = new Logger({ name: 'ServiceRegistration' });

interface ServiceRegistrationConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** Service name */
    serviceName: string;

    /** Base URL for the service */
    apiUrl: string;

    /** Heartbeat interval in ms (default: 30000) */
    heartbeatInterval?: number;

    /** Stale threshold in ms (default: 60000) */
    staleThreshold?: number;
}

export class ServiceRegistration {
    private config: ServiceRegistrationConfig;
    private servicesDir: string;
    private serviceFilePath: string;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private isShuttingDown = false;
    private isStarted = false;
    private currentHostname: string;

    constructor(config: ServiceRegistrationConfig) {
        this.config = {
            heartbeatInterval: 30000,
            staleThreshold: 60000,
            ...config
        };

        this.currentHostname = hostname();
        this.servicesDir = `${this.config.metaCorePath}/services`;
        // Use hostname-based file naming
        this.serviceFilePath = `${this.servicesDir}/${this.config.serviceName}-${this.currentHostname}.json`;
    }

    /**
     * Ensure services directory exists
     */
    private async ensureServicesDir(): Promise<void> {
        await fs.mkdir(this.servicesDir, { recursive: true });
    }

    /**
     * Build service info for this service
     */
    private buildServiceInfo(status: ServiceInfo['status']): ServiceInfo {
        return {
            name: this.config.serviceName,
            hostname: this.currentHostname,
            baseUrl: this.config.apiUrl,
            status,
            lastHeartbeat: new Date().toISOString()
        };
    }

    /**
     * Register this service by writing service info to the shared filesystem.
     * meta-core's cleanup process monitors these files and removes stale entries.
     */
    async register(): Promise<void> {
        await this.ensureServicesDir();

        const info = this.buildServiceInfo('running');
        await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));

        logger.info(`Registered ${this.config.serviceName}-${this.currentHostname}`);
    }

    /**
     * Update service status
     */
    async updateStatus(status: ServiceInfo['status']): Promise<void> {
        try {
            const content = await fs.readFile(this.serviceFilePath, 'utf-8');
            const info = JSON.parse(content) as ServiceInfo;

            info.status = status;
            info.lastHeartbeat = new Date().toISOString();

            await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));
        } catch (error) {
            logger.error('Failed to update status:', error);
        }
    }

    /**
     * Send heartbeat (update lastHeartbeat timestamp)
     */
    async heartbeat(): Promise<void> {
        try {
            const content = await fs.readFile(this.serviceFilePath, 'utf-8');
            const info = JSON.parse(content) as ServiceInfo;

            info.lastHeartbeat = new Date().toISOString();

            await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));
        } catch (error: any) {
            // If file was deleted, re-register
            if (error.code === 'ENOENT') {
                await this.register();
            } else {
                logger.error('Heartbeat failed:', error);
            }
        }
    }

    /**
     * Start heartbeat loop
     */
    startHeartbeat(): void {
        this.heartbeatTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.heartbeat();
        }, this.config.heartbeatInterval);
    }

    /**
     * Stop heartbeat loop
     */
    stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Unregister this service (on shutdown)
     */
    async unregister(): Promise<void> {
        this.isShuttingDown = true;
        this.stopHeartbeat();

        try {
            // Remove the service file
            await fs.unlink(this.serviceFilePath);
            logger.info(`Unregistered ${this.config.serviceName}-${this.currentHostname}`);
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                logger.error('Failed to unregister:', error);
            }
        }
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Full startup sequence: register service and start heartbeat loop.
     */
    async start(): Promise<void> {
        if (this.isStarted) return;

        await this.register();
        this.startHeartbeat();
        this.isStarted = true;

        logger.info(`Started ${this.config.serviceName} at ${this.config.apiUrl}`);
    }

    /**
     * Full shutdown sequence
     */
    async stop(): Promise<void> {
        if (!this.isStarted) return;

        await this.unregister();
        this.isStarted = false;
    }

    // ========================================================================
    // Getters
    // ========================================================================

    getServiceFilePath(): string {
        return this.serviceFilePath;
    }

    getServicesDir(): string {
        return this.servicesDir;
    }

    getIsStarted(): boolean {
        return this.isStarted;
    }
}
