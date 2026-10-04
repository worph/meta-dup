/**
 * Beacon v2 — local resource advertise / discover over UDP multicast
 * (239.255.99.1:9099).
 *
 * Every node advertises resources tagged with capability strings
 * (`metamesh.core`, `metamesh.service/meta-sort`, `metamesh.transport/nzb@1`)
 * and keeps a live view of everyone else's. This service uses it to locate
 * meta-core (the `metamesh.core` resource carries its /urls block) and to feed
 * the nav menu (`metamesh.service/*`), with no shared volume.
 *
 * The normative spec is docs/project-architecture/beacon-v2.md.
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

export const PROTO = 'beacon';
export const VERSION = 2;
export const DEFAULT_GROUP = '239.255.99.1';
export const DEFAULT_PORT = 9099;
export const DEFAULT_INTERVAL_MS = 10_000;
/** A node unheard for interval × this is dropped (evaluated at read time). */
export const LIVENESS_FACTOR = 3;
/** Senders stay under this so nothing fragments. */
export const MAX_DATAGRAM = 1400;

export const TYPE_PROBE = 'probe';
export const TYPE_ADVERTISE = 'advertise';
export const TYPE_BYE = 'bye';

export const CAP_CORE = 'metamesh.core';
export const CAP_SERVICE_PREFIX = 'metamesh.service/';
export const CAP_ANY_SERVICE = 'metamesh.service/*';

/** Mirrors meta-core's GET /urls response minus redisUrl (retired). */
export interface MeshUrls {
    hostname: string;
    baseUrl: string;
    apiUrl: string;
    webdavUrl: string;
    webdavUrlInternal: string;
}

export interface BeaconNodeInfo {
    name: string;
    instance: string;
    version?: string;
    /** 'starting' | 'running'; absent reads as running. */
    status?: string;
}

export interface BeaconResource {
    id: string;
    caps: string[];
    /** Well-known: http, ui, manifest, mcp. A '/…' value is relative to http. */
    endpoints?: Record<string, string>;
    rev?: string;
    /** The one consumer instance this resource belongs to. */
    binds?: string;
    data?: Record<string, unknown>;
}

export interface BeaconMessage {
    proto: string;
    v: number;
    type: string;
    node?: BeaconNodeInfo;
    resources?: BeaconResource[];
    from?: string;
    want?: string[];
}

/** A node as served by /api/neighbors. */
export interface MeshNeighbor extends BeaconNodeInfo {
    resources: BeaconResource[];
    /** Every resource's caps, flattened. */
    caps: string[];
    /** The metamesh.service/* resource's endpoints.ui (v1-compatible field). */
    baseUrl?: string;
    /** Source address taken from the packet, never from the payload. */
    addr: string;
    /** Unix seconds. */
    lastSeen: number;
}

export interface MeshNodeConfig {
    name: string;
    instance?: string;
    version?: string;
    group?: string;
    port?: number;
    intervalMs?: number;
    enabled?: boolean;
    /** Rebuilt on every advertise so the payload never goes stale. */
    payload?: () => { status?: string; resources: BeaconResource[] };
}

/** How a discovered resource relates to this consumer (Scan card). */
export type ScanState = 'configured' | 'addable' | 'bound-elsewhere';

export interface ScanCandidate {
    instance: string;
    name: string;
    version?: string;
    resourceId: string;
    caps: string[];
    /** endpoints.http — what the consumer would register. */
    url: string;
    binds?: string;
    state: ScanState;
    /** The list entry that already holds this URL (state `configured`). */
    configuredAs?: string;
    /** A list-safe name to register it under. */
    suggestedName: string;
}

/** Same JSON as meta-feeder-sdk `beacon::ScanReport`. */
export interface ScanReport {
    cap: string;
    self: string;
    durationMs: number;
    summary: { nodes: number; capable: number; configured: number; boundElsewhere: number; addable: number };
    candidates: ScanCandidate[];
}

/** Lower-case, `[a-z0-9._-]` only — accepted by every consumer's name rules. */
export function suggestedName(instance: string): string {
    const s = instance.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    return s || 'plugin';
}

const normUrl = (u: string) => u.trim().replace(/\/+$/, '');

/**
 * Classify every resource matching `pattern` against the consumer's
 * `(name, url)` list. Mirrors meta-feeder-sdk `beacon::classify`.
 */
export function classifyScan(
    pattern: string,
    self: string,
    neighbors: MeshNeighbor[],
    configured: Array<[string, string]>,
): ScanReport {
    const summary = { nodes: neighbors.length, capable: 0, configured: 0, boundElsewhere: 0, addable: 0 };
    const candidates: ScanCandidate[] = [];
    for (const n of neighbors) {
        for (const r of n.resources) {
            if (!resourceMatches(r, pattern)) continue;
            const http = resourceEndpoint(r, 'http');
            if (!http) continue; // nothing a consumer could register
            const url = normUrl(http);
            summary.capable++;
            const hit = configured.find(([, u]) => normUrl(u) === url);
            let state: ScanState;
            if (hit) { state = 'configured'; summary.configured++; }
            else if (r.binds && r.binds !== self) { state = 'bound-elsewhere'; summary.boundElsewhere++; }
            else { state = 'addable'; summary.addable++; }
            candidates.push({
                instance: n.instance,
                name: n.name,
                ...(n.version ? { version: n.version } : {}),
                resourceId: r.id,
                caps: r.caps ?? [],
                url,
                ...(r.binds ? { binds: r.binds } : {}),
                state,
                ...(hit ? { configuredAs: hit[0] } : {}),
                suggestedName: suggestedName(n.instance),
            });
        }
    }
    const rank: Record<ScanState, number> = { addable: 0, configured: 1, 'bound-elsewhere': 2 };
    candidates.sort((a, b) => rank[a.state] - rank[b.state] || a.instance.localeCompare(b.instance));
    return { cap: pattern, self, durationMs: 0, summary, candidates };
}

/**
 * Does capability `cap` satisfy `pattern`? `*` matches everything; an `@N` on
 * the pattern must equal the cap's contract (none ignores it); `x/*` matches
 * any variant of `x`; otherwise the bases must be equal.
 */
export function capMatches(pattern: string, cap: string): boolean {
    if (pattern === '*') return true;
    const split = (s: string): [string, string | null] => {
        const i = s.lastIndexOf('@');
        return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, null];
    };
    const [pbase, pc] = split(pattern);
    const [cbase, cc] = split(cap);
    if (pc !== null && cc !== pc) return false;
    if (pbase.endsWith('/*')) {
        const prefix = pbase.slice(0, -2);
        if (!cbase.startsWith(prefix)) return false;
        const rest = cbase.slice(prefix.length);
        return rest.startsWith('/') && rest.length > 1;
    }
    return pbase === cbase;
}

export function resourceMatches(r: BeaconResource, pattern: string): boolean {
    return (r.caps ?? []).some((c) => capMatches(pattern, c));
}

/** The named endpoint as an absolute URL ('/…' joins onto endpoints.http). */
export function resourceEndpoint(r: BeaconResource, name: string): string | undefined {
    const v = r.endpoints?.[name];
    if (!v) return undefined;
    if (!v.startsWith('/')) return v;
    const base = r.endpoints?.http;
    return base ? base.replace(/\/+$/, '') + v : undefined;
}

/**
 * Decode a datagram; null for anything that is not a well-formed beacon v2
 * message (beacon v1, meta-discovery v1, other versions, junk).
 */
export function parseMessage(buf: Buffer): BeaconMessage | null {
    let m: BeaconMessage;
    try {
        m = JSON.parse(buf.toString('utf8')) as BeaconMessage;
    } catch {
        return null;
    }
    if (!m || m.proto !== PROTO || m.v !== VERSION) return null;
    if (m.type === TYPE_PROBE) return m;
    if (m.type === TYPE_ADVERTISE || m.type === TYPE_BYE) {
        if (!m.node?.name || !m.node?.instance) return null;
        return m;
    }
    return null;
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

function envNum(key: string): number | undefined {
    const n = Number(process.env[key]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface Seen {
    node: BeaconNodeInfo;
    resources: BeaconResource[];
    addr: string;
    lastSeen: number; // ms
}

function toNeighbor(s: Seen): MeshNeighbor {
    const caps: string[] = [];
    let baseUrl: string | undefined;
    for (const r of s.resources) {
        for (const c of r.caps ?? []) if (!caps.includes(c)) caps.push(c);
        if (!baseUrl && resourceMatches(r, CAP_ANY_SERVICE)) baseUrl = resourceEndpoint(r, 'ui');
    }
    return {
        ...s.node,
        resources: s.resources,
        caps,
        ...(baseUrl ? { baseUrl } : {}),
        addr: s.addr,
        lastSeen: s.lastSeen / 1000,
    };
}

/**
 * One beacon v2 participant: advertises its resources, answers probes, and
 * keeps a TTL map of every other node.
 */
export class MeshNode {
    private cfg: Required<Omit<MeshNodeConfig, 'payload'>> & Pick<MeshNodeConfig, 'payload'>;
    private socket: dgram.Socket | null = null;
    private timer: NodeJS.Timeout | null = null;
    private nodes = new Map<string, Seen>();
    private ifaceAddrs: string[] = [];
    private listeners: ((n: MeshNeighbor) => void)[] = [];
    private started = false;

    constructor(config: MeshNodeConfig) {
        this.cfg = {
            name: config.name,
            instance: config.instance ?? hostname(),
            version: config.version ?? '',
            group: config.group ?? process.env.BEACON_GROUP ?? DEFAULT_GROUP,
            port: config.port ?? envNum('BEACON_PORT') ?? DEFAULT_PORT,
            intervalMs: config.intervalMs ?? envNum('BEACON_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS,
            enabled: config.enabled ?? true,
            payload: config.payload,
        };
    }

    async start(): Promise<void> {
        if (this.started || !this.cfg.enabled) {
            if (!this.cfg.enabled) console.log('[beacon] Disabled by configuration');
            return;
        }
        this.started = true;

        await new Promise<void>((resolve) => {
            // reuseAddr sets SO_REUSEADDR (+ SO_REUSEPORT on Linux for udp4),
            // so several listeners can share 9099 on one host.
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this.socket = socket;

            socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
            socket.on('error', (err) => {
                // Never fatal: a host that blocks multicast must degrade, not
                // take the service down.
                console.error('[beacon] Socket error:', err.message);
            });

            socket.bind(this.cfg.port, '0.0.0.0', () => {
                try {
                    socket.setMulticastTTL(1); // link-local only
                } catch (e) {
                    console.warn('[beacon] Could not set multicast TTL:', e);
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
                        console.warn(`[beacon] Join ${this.cfg.group} on ${addr} failed:`, e);
                    }
                }
                console.log(
                    `[beacon] Listening on ${this.cfg.group}:${this.cfg.port} as ` +
                    `${this.cfg.name}/${this.cfg.instance} (joined ${joined} of ${this.ifaceAddrs.length} interfaces)`
                );
                resolve();
            });
        });

        this.advertise();
        this.probe();
        this.timer = setInterval(() => this.advertise(), this.cfg.intervalMs);
        // Don't hold the event loop open on shutdown.
        this.timer.unref?.();
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        // Bye, so neighbours drop us immediately rather than waiting out the
        // staleness window.
        this.multicast({ proto: PROTO, v: VERSION, type: TYPE_BYE, node: this.nodeInfo() });
        await new Promise<void>((resolve) => {
            if (!this.socket) return resolve();
            try { this.socket.close(() => resolve()); } catch { resolve(); }
        });
        this.socket = null;
        this.listeners = [];
    }

    /**
     * Multicast a probe. Every node owning a resource matching one of `want`
     * (every node, when empty) replies immediately.
     */
    probe(want: string[] = []): void {
        const msg: BeaconMessage = { proto: PROTO, v: VERSION, type: TYPE_PROBE, from: this.cfg.instance };
        if (want.length) msg.want = want;
        this.multicast(msg);
    }

    /** Every live node, sorted by (name, instance). */
    getNeighbors(): MeshNeighbor[] {
        const cutoff = Date.now() - this.cfg.intervalMs * LIVENESS_FACTOR;
        const out: MeshNeighbor[] = [];
        for (const [key, s] of this.nodes) {
            if (s.lastSeen < cutoff) { this.nodes.delete(key); continue; }
            out.push(toNeighbor(s));
        }
        return out.sort((a, b) => a.name.localeCompare(b.name) || a.instance.localeCompare(b.instance));
    }

    /** One row per node name, most recently seen instance wins. */
    getNeighborsByName(): MeshNeighbor[] {
        const best = new Map<string, MeshNeighbor>();
        for (const nb of this.getNeighbors()) {
            const cur = best.get(nb.name);
            if (!cur || nb.lastSeen > cur.lastSeen) best.set(nb.name, nb);
        }
        return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * The Scan card: probe everyone, wait `waitMs` for the replies, then
     * classify what matches `pattern` against `configured` ([name, url]).
     */
    async scan(pattern: string, configured: Array<[string, string]>, waitMs = 1500): Promise<ScanReport> {
        const started = Date.now();
        this.probe();
        await new Promise((r) => setTimeout(r, waitMs));
        const report = classifyScan(pattern, this.cfg.instance, this.getNeighbors(), configured);
        report.durationMs = Date.now() - started;
        return report;
    }

    /** This node as a row, so a UI can render itself without waiting. */
    self(): MeshNeighbor {
        const { status, resources } = this.payload();
        return toNeighbor({ node: this.nodeInfo(status), resources, addr: '', lastSeen: Date.now() });
    }

    /** Fires for every advertise received (after the self-echo filter). */
    onAdvertise(cb: (n: MeshNeighbor) => void): void {
        this.listeners.push(cb);
    }

    private payload(): { status?: string; resources: BeaconResource[] } {
        return this.cfg.payload ? this.cfg.payload() : { resources: [] };
    }

    private nodeInfo(status?: string): BeaconNodeInfo {
        const n: BeaconNodeInfo = { name: this.cfg.name, instance: this.cfg.instance };
        if (this.cfg.version) n.version = this.cfg.version;
        if (status) n.status = status;
        return n;
    }

    private advertiseMsg(): BeaconMessage {
        const { status, resources } = this.payload();
        return { proto: PROTO, v: VERSION, type: TYPE_ADVERTISE, node: this.nodeInfo(status), resources };
    }

    private onMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
        const msg = parseMessage(buf);
        if (!msg) return; // v1 or foreign traffic on the shared group

        if (msg.type === TYPE_PROBE) {
            if (msg.from === this.cfg.instance) return;
            const ad = this.advertiseMsg();
            const want = msg.want ?? [];
            const wanted = want.length === 0 ||
                (ad.resources ?? []).some((r) => want.some((p) => resourceMatches(r, p)));
            if (wanted) this.replyTo(ad, rinfo);
            return;
        }

        const node = msg.node!;
        if (node.instance === this.cfg.instance) return; // our own echo
        if (msg.type === TYPE_BYE) { this.nodes.delete(node.instance); return; }

        const seen: Seen = { node, resources: msg.resources ?? [], addr: rinfo.address, lastSeen: Date.now() };
        this.nodes.set(node.instance, seen);
        const nb = toNeighbor(seen);
        for (const cb of this.listeners) {
            try { cb(nb); } catch (e) { console.error('[beacon] Listener threw:', e); }
        }
    }

    private encode(msg: BeaconMessage): Buffer {
        const body = Buffer.from(JSON.stringify(msg));
        if (body.length > MAX_DATAGRAM) {
            console.warn(`[beacon] ${body.length}-byte datagram exceeds the fragmentation-safe ${MAX_DATAGRAM}`);
        }
        return body;
    }

    private advertise(): void {
        this.multicast(this.advertiseMsg());
    }

    private replyTo(msg: BeaconMessage, rinfo: dgram.RemoteInfo): void {
        try {
            this.socket?.send(this.encode(msg), rinfo.port, rinfo.address);
        } catch (e) {
            console.warn('[beacon] Reply failed:', e);
        }
    }

    /** Writes once per interface — the default route alone reaches one network. */
    private multicast(msg: BeaconMessage): void {
        const socket = this.socket;
        if (!socket) return;
        const body = this.encode(msg);
        for (const addr of this.ifaceAddrs) {
            try {
                socket.setMulticastInterface(addr);
                socket.send(body, this.cfg.port, this.cfg.group);
            } catch (e) {
                console.warn(`[beacon] Send on ${addr} failed:`, e);
            }
        }
    }
}

export interface MetaCoreLocatorConfig {
    /** This service's name, for its own advertise. */
    serviceName: string;
    /** Browser-facing URL for the nav menu. */
    baseUrl?: string;
    version?: string;
    /**
     * Explicit meta-core API URL. When set this ALWAYS wins and the wire is
     * never consulted for core selection — see the spec's "the
     * metamesh.core pin". This is what stops a client box from latching onto a
     * gateway box's core when both are reachable on a shared network.
     */
    metaCoreUrl?: string;
    group?: string;
    port?: number;
    intervalMs?: number;
    enabled?: boolean;
}

/**
 * Locates meta-core over beacon v2 (the first `metamesh.core` resource that
 * carries `data.urls`), and advertises this service as
 * `metamesh.service/<serviceName>`.
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
            version: config.version,
            group: config.group,
            port: config.port,
            intervalMs: config.intervalMs,
            enabled: config.enabled,
            payload: () => ({
                resources: [{
                    id: 'service',
                    caps: [CAP_SERVICE_PREFIX + config.serviceName],
                    endpoints: { ui: config.baseUrl ?? `http://${localIPv4()}` },
                }],
            }),
        });

        this.node.onAdvertise((nb) => {
            if (this.cfg.metaCoreUrl) return; // pinned: the wire cannot move us
            const core = nb.resources.find((r) => resourceMatches(r, CAP_CORE));
            const urls = core?.data?.urls as MeshUrls | undefined;
            if (!urls?.apiUrl) return;

            const prev = this.current;
            if (!prev) {
                this.current = urls;
                console.log(`[beacon] meta-core discovered at ${urls.apiUrl} (${nb.addr})`);
                this.notifyChange();
                return;
            }
            if (prev.apiUrl === urls.apiUrl) {
                this.current = urls; // refresh the rest of the fields
                return;
            }
            // A second, different core is advertising. Do not flap between
            // them — keep the first and say so loudly, because on a PCS box
            // this means a client container can see the gateway's core.
            console.warn(
                `[beacon] Ignoring a second meta-core at ${urls.apiUrl} (${nb.addr}); ` +
                `staying with ${prev.apiUrl}. Set META_CORE_URL to pin this explicitly.`
            );
        });
    }

    async start(): Promise<void> {
        if (this.cfg.metaCoreUrl) {
            console.log(`[beacon] meta-core pinned to ${this.cfg.metaCoreUrl}; discovery is advisory`);
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
            if (!logged) { console.log('[beacon] Waiting for meta-core...'); logged = true; }
            this.node.probe([CAP_CORE]);
            await new Promise((r) => setTimeout(r, 500));
        }
        throw new Error(`[beacon] No meta-core found within ${timeoutMs}ms`);
    }

    /** Fires when the elected core's apiUrl changes. Replaces the fs.watch. */
    onChange(cb: () => void): void {
        this.changeCallbacks.push(cb);
    }

    /**
     * Neighbours for /api/neighbors: one row per name (or every instance with
     * `all`), optionally only nodes with a resource matching `cap`.
     */
    getNeighbors(opts: { all?: boolean; cap?: string } = {}): MeshNeighbor[] {
        const list = opts.all ? this.node.getNeighbors() : this.node.getNeighborsByName();
        const cap = opts.cap;
        return cap ? list.filter((n) => n.resources.some((r) => resourceMatches(r, cap))) : list;
    }

    self(): MeshNeighbor {
        return this.node.self();
    }

    /** The Scan card — see {@link MeshNode.scan}. */
    scan(pattern: string, configured: Array<[string, string]>, waitMs = 1500): Promise<ScanReport> {
        return this.node.scan(pattern, configured, waitMs);
    }

    probe(want: string[] = []): void {
        this.node.probe(want);
    }

    private notifyChange(): void {
        for (const cb of this.changeCallbacks) {
            try { cb(); } catch (e) { console.error('[beacon] Change callback threw:', e); }
        }
    }
}
