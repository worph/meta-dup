/**
 * API Server for meta-dup
 *
 * REST API endpoints:
 * - GET  /health              - Health check
 * - GET  /api/duplicates      - Get all duplicates
 * - GET  /api/duplicates/hash - Hash duplicates only
 * - GET  /api/duplicates/title - Title duplicates only
 * - GET  /api/duplicates/stats - Statistics
 * - POST /api/duplicates/rebuild - Force rebuild from Redis
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Logger } from 'tslog';
import { DuplicateIndex } from '../DuplicateIndex.js';
import { KVManager } from '../kv/KVManager.js';
import { RedisClient } from '../kv/RedisClient.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const logger = new Logger({ name: 'APIServer' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface APIServerConfig {
    port: number;
    host: string;
}

export class APIServer {
    private app: FastifyInstance;
    private config: APIServerConfig;
    private duplicateIndex: DuplicateIndex;
    private kvManager: KVManager;
    private redisClient: RedisClient | null = null;

    constructor(
        duplicateIndex: DuplicateIndex,
        config: APIServerConfig,
        kvManager: KVManager
    ) {
        this.duplicateIndex = duplicateIndex;
        this.config = config;
        this.kvManager = kvManager;

        this.app = Fastify({
            logger: false,
        });

        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Set Redis client (called after connection established)
     */
    setRedisClient(client: RedisClient): void {
        this.redisClient = client;
    }

    /**
     * Setup middleware
     */
    private setupMiddleware(): void {
        // Enable CORS
        this.app.register(cors, {
            origin: true,
            credentials: true,
        });

        // Serve static UI files if they exist
        const uiDistPath = join(__dirname, '../../..', 'meta-dup-ui', 'dist');
        if (existsSync(uiDistPath)) {
            this.app.register(fastifyStatic, {
                root: uiDistPath,
                prefix: '/',
            });
            logger.info(`Serving UI from ${uiDistPath}`);
        } else {
            logger.info('UI dist not found, serving API only');
        }
    }

    /**
     * Setup routes
     */
    private setupRoutes(): void {
        // Health check
        this.app.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
            const isHealthy = await this.kvManager.isHealthy();
            const stats = this.duplicateIndex.getStats();

            return {
                status: isHealthy ? 'ok' : 'degraded',
                service: 'meta-dup',
                redis: isHealthy,
                stats: {
                    filesTracked: stats.totalFilesTracked,
                    hashDuplicates: stats.hashGroupCount,
                    titleDuplicates: stats.titleGroupCount,
                },
                timestamp: new Date().toISOString(),
            };
        });

        // Get all duplicates
        this.app.get('/api/duplicates', async (request: FastifyRequest, reply: FastifyReply) => {
            return this.duplicateIndex.getDuplicateData();
        });

        // Get hash duplicates only
        this.app.get('/api/duplicates/hash', async (request: FastifyRequest, reply: FastifyReply) => {
            return {
                duplicates: this.duplicateIndex.getHashDuplicates(),
                computedAt: new Date().toISOString(),
            };
        });

        // Get title duplicates only
        this.app.get('/api/duplicates/title', async (request: FastifyRequest, reply: FastifyReply) => {
            return {
                duplicates: this.duplicateIndex.getTitleDuplicates(),
                computedAt: new Date().toISOString(),
            };
        });

        // Get statistics
        this.app.get('/api/duplicates/stats', async (request: FastifyRequest, reply: FastifyReply) => {
            return this.duplicateIndex.getStats();
        });

        // Force rebuild from Redis
        this.app.post('/api/duplicates/rebuild', async (request: FastifyRequest, reply: FastifyReply) => {
            if (!this.redisClient) {
                reply.status(503);
                return { error: 'Redis not connected' };
            }

            logger.info('Manual rebuild requested');
            const startTime = Date.now();
            await this.duplicateIndex.rebuildFromRedis(this.redisClient);
            const elapsed = Date.now() - startTime;

            return {
                success: true,
                message: 'Index rebuilt from Redis',
                elapsedMs: elapsed,
                stats: this.duplicateIndex.getStats(),
            };
        });

        // Service discovery (for dashboard navigation)
        this.app.get('/api/services', async (request: FastifyRequest, reply: FastifyReply) => {
            const services: Array<{
                name: string;
                url: string;
                api: string;
                status: string;
                role?: string;
            }> = [];

            try {
                const serviceDiscovery = this.kvManager.getServiceDiscovery();
                if (serviceDiscovery) {
                    const allServices = await serviceDiscovery.discoverAllServices();

                    for (const svc of allServices) {
                        services.push({
                            name: svc.name || 'Unknown',
                            url: svc.baseUrl || '',
                            api: svc.baseUrl || '',
                            status: svc.status || 'unknown',
                            role: svc.role,
                        });
                    }
                }
            } catch (error: any) {
                logger.error('Error discovering services:', error);
            }

            return {
                services,
                current: 'meta-dup',
            };
        });

        // Catch-all for SPA routing (serve index.html for non-API routes)
        this.app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
            const uiDistPath = join(__dirname, '../../..', 'meta-dup-ui', 'dist');
            const indexPath = join(uiDistPath, 'index.html');

            if (existsSync(indexPath) && !request.url.startsWith('/api/')) {
                return reply.sendFile('index.html');
            }

            reply.status(404);
            return { error: 'Not found' };
        });
    }

    /**
     * Start the server
     */
    async start(): Promise<void> {
        try {
            await this.app.listen({
                port: this.config.port,
                host: this.config.host,
            });
            logger.info(`API server listening on ${this.config.host}:${this.config.port}`);
        } catch (error) {
            logger.error('Failed to start API server:', error);
            throw error;
        }
    }

    /**
     * Stop the server
     */
    async stop(): Promise<void> {
        await this.app.close();
        logger.info('API server stopped');
    }
}
