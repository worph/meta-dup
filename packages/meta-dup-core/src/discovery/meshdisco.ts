/**
 * meta-discovery v1 — UDP multicast service discovery.
 *
 * Replaces the two file-based mechanisms that required a shared /meta-core
 * volume: `locks/kv-leader.info` (locating meta-core at boot) and
 * `services/<name>-<host>.json` (the dashboard nav registry). Both answered the
 * same question — where is meta-core, and who else is on this network — so one
 * announce packet answers both, and discovery scope becomes the docker network
 * rather than the mounted volume.
 *
 * The normative spec is docs/project-architecture/service-discovery.md.
 *
 * ⚠ MIRRORED FILE. Byte-identical copies live in meta-sort-core, meta-fuse-core
 * and meta-dup-core. They cannot share a package: meta-fuse-core and
 * meta-dup-core do not depend on @metazla/meta-interface at all, and each
 * submodule is its own Docker build context, so a workspace dep resolves
 * outside the build. Edit one copy → edit all three, and
 * `scripts/check-mirrors.sh` will tell you if you forgot.
 */

import dgram from 'dgram';
import { hostname, networkInterfaces } from 'os';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_GROUP = '239.255.77.1';
export const DEFAULT_PORT = 9399;
export const DEFAULT_INTERVAL_MS = 10_000;
/** A neighbour unseen for interval × this is dropped. Replaces the reaper. */
export const LIVENESS_FACTOR = 3;

export const TYPE_DISCOVERY = 'discovery';
export const TYPE_ANNOUNCE = 'announce';
export const ROLE_CORE = 'core';
export const ROLE_SERVICE = 'service';

/** Mirrors meta-core's GET /urls response minus redisUrl (retired). */
export interface MeshUrls {
    hostname: string;
    baseUrl: string;
    apiUrl: string;
    webdavUrl: string;
    webdavUrlInternal: string;
}

export interface MeshMessage {
    v: number;
    type: string;
    name?: string;
    instance?: string;
    role?: string;
    version?: string;
    status?: string;
    baseUrl?: string;
    /** Present only when role === 'core'. */
    urls?: MeshUrls;
    /** Reserved for a future HMAC; v1 ignores it. */
    token?: string;
}

export interface MeshNeighbor extends MeshMessage {
    /** Source address taken from the packet, never from the payload. */
    addr: string;
    lastSeen: number;
}

export interface MeshNodeConfig {
    name: string;
    instance?: string;
    role?: string;
    version?: string;
    group?: string;
    port?: number;
    intervalMs?: number;
    enabled?: boolean;
    /** Rebuilt on every announce so the payload never goes stale. */
    payload?: () => { baseUrl?: string; status?: string; urls?: MeshUrls };
}

/** IPv4 addresses of every up, non-internal interface. */
function localInterfaceAddresses(): string[] {
    const out: string[] = [];
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const ni of nets[name] ?? []) {
            // Node has flip-flopped between 'IPv4' and 4 for `family`.
            const isV4 = (ni as { family: string | number }).family === 'IPv4' ||
                (ni as { family: string | number }).family === 4;
            if (isV4 && !ni.internal && ni.address) out.push(ni.address);
        }
    }
    return out;
}

/** First non-internal IPv4 address, or the hostname. Matches the Go helper. */
export function localIPv4(): string {
    return localInterfaceAddresses()[0] ?? hostname();
}

/**
 * One participant in the mesh: announces itself, answers probes, and keeps a
 * TTL map of everyone else.
 */
export class MeshNode {
    private cfg: Required<Omit<MeshNodeConfig, 'payload'>> & Pick<MeshNodeConfig, 'payload'>;
    private socket: dgram.Socket | null = null;
    private timer: NodeJS.Timeout | null = null;
    private neighbors = new Map<string, MeshNeighbor>();
    private ifaceAddrs: string[] = [];
    private listeners: ((n: MeshNeighbor) => void)[] = [];
    private started = false;

    constructor(config: MeshNodeConfig) {
        this.cfg = {
            name: config.name,
            instance: config.instance ?? hostname(),
            role: config.role ?? ROLE_SERVICE,
            version: config.version ?? '',
            group: config.group ?? DEFAULT_GROUP,
            port: config.port ?? DEFAULT_PORT,
            intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
            enabled: config.enabled ?? true,
            payload: config.payload,
        };
    }

    async start(): Promise<void> {
        if (this.started || !this.cfg.enabled) {
            if (!this.cfg.enabled) console.log('[meshdisco] Disabled by configuration');
            return;
        }
        this.started = true;

        await new Promise<void>((resolve) => {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this.socket = socket;

            socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
            socket.on('error', (err) => {
                // Never fatal: a host that blocks multicast must degrade, not
                // take the service down.
                console.error('[meshdisco] Socket error:', err.message);
            });

            socket.bind(this.cfg.port, '0.0.0.0', () => {
                try {
                    socket.setMulticastTTL(1); // link-local only
                } catch (e) {
                    console.warn('[meshdisco] Could not set multicast TTL:', e);
                }

                // Join on EVERY interface. A container on two docker networks
                // that joins only the default route silently sees one network.
                this.ifaceAddrs = localInterfaceAddresses();
                let joined = 0;
                for (const addr of this.ifaceAddrs) {
                    try {
                        socket.addMembership(this.cfg.group, addr);
                        joined++;
                    } catch (e) {
                        console.warn(`[meshdisco] Join ${this.cfg.group} on ${addr} failed:`, e);
                    }
                }
                console.log(
                    `[meshdisco] Listening on ${this.cfg.group}:${this.cfg.port} as ` +
                    `${this.cfg.name}/${this.cfg.instance} (joined ${joined} of ${this.ifaceAddrs.length} interfaces)`
                );
                resolve();
            });
        });

        this.announce();
        this.probe();
        this.timer = setInterval(() => this.announce(), this.cfg.intervalMs);
        // Don't hold the event loop open on shutdown.
        this.timer.unref?.();
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        // Final "stopping" announce so neighbours drop us immediately rather
        // than waiting out the staleness window.
        this.announce('stopping');
        await new Promise<void>((resolve) => {
            if (!this.socket) return resolve();
            try { this.socket.close(() => resolve()); } catch { resolve(); }
        });
        this.socket = null;
        this.listeners = [];
    }

    /** Multicast a probe; every listener replies immediately. */
    probe(): void {
        this.send({ v: PROTOCOL_VERSION, type: TYPE_DISCOVERY });
    }

    /** Everyone heard from inside the staleness window, sorted by name. */
    getNeighbors(): MeshNeighbor[] {
        const cutoff = Date.now() - this.cfg.intervalMs * LIVENESS_FACTOR;
        const out: MeshNeighbor[] = [];
        for (const [key, nb] of this.neighbors) {
            if (nb.lastSeen < cutoff) { this.neighbors.delete(key); continue; }
            out.push(nb);
        }
        return out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    }

    /** One row per service name, most recently seen instance wins. */
    getNeighborsByName(): MeshNeighbor[] {
        const best = new Map<string, MeshNeighbor>();
        for (const nb of this.getNeighbors()) {
            const cur = best.get(nb.name ?? '');
            if (!cur || nb.lastSeen > cur.lastSeen) best.set(nb.name ?? '', nb);
        }
        return [...best.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    }

    /** Cores only — what a locator filters on. */
    getCores(): MeshNeighbor[] {
        return this.getNeighbors().filter((n) => n.role === ROLE_CORE && n.urls);
    }

    /** This node's own announce, so a UI can render itself without waiting. */
    self(): MeshNeighbor {
        return { ...this.buildAnnounce('running'), addr: '', lastSeen: Date.now() };
    }

    /** Fires for every announce received (after the self-echo filter). */
    onAnnounce(cb: (n: MeshNeighbor) => void): void {
        this.listeners.push(cb);
    }

    private onMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
        let msg: MeshMessage;
        try {
            msg = JSON.parse(buf.toString('utf8')) as MeshMessage;
        } catch {
            return; // foreign traffic on the group
        }
        if (msg.v !== PROTOCOL_VERSION) return;
        // Drop our own multicast echo.
        if (msg.instance && msg.instance === this.cfg.instance && msg.name === this.cfg.name) return;

        if (msg.type === TYPE_DISCOVERY) {
            this.replyTo(rinfo);
            return;
        }
        if (msg.type !== TYPE_ANNOUNCE || !msg.name) return;

        const key = msg.instance ? `${msg.name}|${msg.instance}` : msg.name;
        if (msg.status === 'stopping') { this.neighbors.delete(key); return; }

        const nb: MeshNeighbor = { ...msg, addr: rinfo.address, lastSeen: Date.now() };
        this.neighbors.set(key, nb);
        for (const cb of this.listeners) {
            try { cb(nb); } catch (e) { console.error('[meshdisco] Listener threw:', e); }
        }
    }

    private buildAnnounce(status: string): MeshMessage {
        const msg: MeshMessage = {
            v: PROTOCOL_VERSION,
            type: TYPE_ANNOUNCE,
            name: this.cfg.name,
            instance: this.cfg.instance,
            role: this.cfg.role,
            version: this.cfg.version,
            status,
        };
        if (this.cfg.payload) {
            const p = this.cfg.payload();
            if (p.baseUrl) msg.baseUrl = p.baseUrl;
            if (p.status && status === 'running') msg.status = p.status;
            // Only a core may carry a URLs block — a service announcing one
            // would let any container impersonate meta-core.
            if (this.cfg.role === ROLE_CORE && p.urls) msg.urls = p.urls;
        }
        return msg;
    }

    private announce(status = 'running'): void {
        this.send(this.buildAnnounce(status));
    }

    private replyTo(rinfo: dgram.RemoteInfo): void {
        const body = Buffer.from(JSON.stringify(this.buildAnnounce('running')));
        try {
            this.socket?.send(body, rinfo.port, rinfo.address);
        } catch (e) {
            console.warn('[meshdisco] Reply failed:', e);
        }
    }

    /** Writes once per interface — the default route alone reaches one network. */
    private send(msg: MeshMessage): void {
        const socket = this.socket;
        if (!socket) return;
        const body = Buffer.from(JSON.stringify(msg));
        for (const addr of this.ifaceAddrs) {
            try {
                socket.setMulticastInterface(addr);
                socket.send(body, this.cfg.port, this.cfg.group);
            } catch (e) {
                console.warn(`[meshdisco] Send on ${addr} failed:`, e);
            }
        }
    }
}

export interface MetaCoreLocatorConfig {
    /** This service's name, for its own announce. */
    serviceName: string;
    /** Browser-facing URL for the nav menu. */
    baseUrl?: string;
    version?: string;
    /**
     * Explicit meta-core API URL. When set this ALWAYS wins and the wire is
     * never consulted for core selection — see the spec's "the pin always
     * wins". This is what stops a client box from latching onto a gateway
     * box's core when both are reachable on a shared network.
     */
    metaCoreUrl?: string;
    group?: string;
    port?: number;
    intervalMs?: number;
    enabled?: boolean;
}

/**
 * Locates meta-core over UDP, replacing the read of
 * /meta-core/locks/kv-leader.info.
 */
export class MetaCoreLocator {
    private node: MeshNode;
    private cfg: MetaCoreLocatorConfig;
    private current: MeshUrls | null = null;
    private changeCallbacks: (() => void)[] = [];

    constructor(config: MetaCoreLocatorConfig) {
        this.cfg = config;
        this.node = new MeshNode({
            name: config.serviceName,
            role: ROLE_SERVICE,
            version: config.version,
            group: config.group,
            port: config.port,
            intervalMs: config.intervalMs,
            enabled: config.enabled,
            payload: () => ({ baseUrl: config.baseUrl ?? `http://${localIPv4()}` }),
        });

        this.node.onAnnounce((nb) => {
            if (nb.role !== ROLE_CORE || !nb.urls) return;
            if (this.cfg.metaCoreUrl) return; // pinned: the wire cannot move us

            const prev = this.current;
            if (!prev) {
                this.current = nb.urls;
                console.log(`[meshdisco] meta-core discovered at ${nb.urls.apiUrl} (${nb.addr})`);
                this.notifyChange();
                return;
            }
            if (prev.apiUrl === nb.urls.apiUrl) {
                this.current = nb.urls; // refresh the rest of the fields
                return;
            }
            // A second, different core is announcing. Do not flap between
            // them — keep the first and say so loudly, because on a PCS box
            // this means a client container can see the gateway's core.
            console.warn(
                `[meshdisco] Ignoring a second meta-core at ${nb.urls.apiUrl} (${nb.addr}); ` +
                `staying with ${prev.apiUrl}. Set META_CORE_URL to pin this explicitly.`
            );
        });
    }

    async start(): Promise<void> {
        if (this.cfg.metaCoreUrl) {
            console.log(`[meshdisco] meta-core pinned to ${this.cfg.metaCoreUrl}; discovery is advisory`);
        }
        await this.node.start();
    }

    async stop(): Promise<void> {
        await this.node.stop();
        this.changeCallbacks = [];
    }

    /** The pin if set, else whatever discovery elected. */
    getApiUrl(): string | null {
        if (this.cfg.metaCoreUrl) return this.cfg.metaCoreUrl;
        return this.current?.apiUrl ?? null;
    }

    /** Full URLs block. null when pinned and /urls has not been fetched yet. */
    getUrls(): MeshUrls | null {
        return this.current;
    }

    /**
     * Block until meta-core is located. Probes immediately and re-probes every
     * 500ms — the same loop shape as the old LeaderClient.waitForLeader, so the
     * 30s boot timeout semantics are preserved exactly.
     */
    async waitForCore(timeoutMs = 30_000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        let logged = false;
        while (Date.now() < deadline) {
            const url = this.getApiUrl();
            if (url) return url;
            if (!logged) { console.log('[meshdisco] Waiting for meta-core...'); logged = true; }
            this.node.probe();
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(`[meshdisco] No meta-core found within ${timeoutMs}ms`);
    }

    /** Fires when the elected core's apiUrl changes. Replaces the fs.watch. */
    onChange(cb: () => void): void {
        this.changeCallbacks.push(cb);
    }

    getNeighbors(): MeshNeighbor[] {
        return this.node.getNeighborsByName();
    }

    self(): MeshNeighbor {
        return this.node.self();
    }

    probe(): void {
        this.node.probe();
    }

    private notifyChange(): void {
        for (const cb of this.changeCallbacks) {
            try { cb(); } catch (e) { console.error('[meshdisco] Change callback threw:', e); }
        }
    }
}
