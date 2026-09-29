// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeId, NodeInfo } from '../types/node-info.ts';
import type { CloudConfig } from '../types/network-config.ts';
import type { NodeIdentity } from '../identity/node-identity.ts';
import type { PeerProbe } from '../types/peer-probe.ts';
import type {
  DiscoveryLayer,
  DiscoveryLayerEventName,
  DiscoveryLayerEvents,
} from './discovery-layer.ts';

// .............................................................................

/** Response from cloud registration / polling */
export interface CloudPeerListResponse {
  /** Peers known to the cloud for this domain */
  peers: NodeInfo[];
  /** Hub assigned by the cloud (null if not yet decided) */
  assignedHub: NodeId | null;
  /**
   * Whether the cloud is coordinating this domain's hub, or only observing it.
   *
   * - `'manual'` (or absent) — **the LAN organises itself.** The local
   *   election decides and `assignedHub` is a cold-start seed, which is what
   *   this layer has always been in practice.
   * - `'auto'` — **cloud-coordinated.** The local election stands down and the
   *   cloud's choice governs, which is the only mode in which a cloud-side
   *   hub policy means anything on a machine.
   *
   * Optional, because a node may be talking to a coordinator older than this
   * field. Absent is read as `'manual'`: the mode that changes nothing.
   */
  hubPolicy?: 'auto' | 'manual';
}

// .............................................................................

/** Abstraction over HTTP fetch for testability */
export interface CloudHttpClient {
  /**
   * Register this node with the cloud service.
   * @param endpoint - Cloud service base URL
   * @param info - This node's info
   * @param apiKey - Optional API key
   * @param tenantId - Optional tenant identifier (required by hosted CloudCoordinator)
   * @returns The peer list response from the cloud
   */
  register(
    endpoint: string,
    info: NodeInfo,
    apiKey?: string,
    tenantId?: string,
  ): Promise<CloudPeerListResponse>;

  /**
   * Poll the cloud for the latest peer list and hub assignment.
   * @param endpoint - Cloud service base URL
   * @param nodeId - This node's ID
   * @param domain - This node's domain
   * @param apiKey - Optional API key
   * @param tenantId - Optional tenant identifier (required by hosted CloudCoordinator)
   * @returns The peer list response from the cloud
   */
  poll(
    endpoint: string,
    nodeId: NodeId,
    domain: string,
    apiKey?: string,
    tenantId?: string,
  ): Promise<CloudPeerListResponse>;

  /**
   * Report probe results to the cloud.
   * @param endpoint - Cloud service base URL
   * @param nodeId - This node's ID
   * @param probes - Probe results to report
   * @param apiKey - Optional API key
   * @param tenantId - Optional tenant identifier (required by hosted CloudCoordinator)
   */
  reportProbes(
    endpoint: string,
    nodeId: NodeId,
    probes: PeerProbe[],
    apiKey?: string,
    tenantId?: string,
  ): Promise<void>;
}

/** Factory type for creating a CloudHttpClient */
export type CreateCloudHttpClient = () => CloudHttpClient;

// .............................................................................

/**
 * Create a real HTTP client using globalThis.fetch.
 * @returns A CloudHttpClient backed by the Fetch API
 */
export function defaultCreateCloudHttpClient(): CloudHttpClient {
  return {
    async register(
      endpoint: string,
      info: NodeInfo,
      apiKey?: string,
      tenantId?: string,
    ): Promise<CloudPeerListResponse> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) headers['x-api-key'] = apiKey;

      const body: Record<string, unknown> = { ...info };
      if (tenantId) body['tenantId'] = tenantId;

      const res = await fetch(`${endpoint}/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Cloud register failed: ${res.status}`);
      }

      return (await res.json()) as CloudPeerListResponse;
    },

    async poll(
      endpoint: string,
      nodeId: NodeId,
      domain: string,
      apiKey?: string,
      tenantId?: string,
    ): Promise<CloudPeerListResponse> {
      const headers: Record<string, string> = {};
      if (apiKey) headers['x-api-key'] = apiKey;

      const params = new URLSearchParams({ nodeId, domain });
      if (tenantId) params.set('tenantId', tenantId);

      const res = await fetch(`${endpoint}/peers?${params.toString()}`, {
        method: 'GET',
        headers,
      });

      if (!res.ok) {
        throw new Error(`Cloud poll failed: ${res.status}`);
      }

      return (await res.json()) as CloudPeerListResponse;
    },

    async reportProbes(
      endpoint: string,
      nodeId: NodeId,
      probes: PeerProbe[],
      apiKey?: string,
      tenantId?: string,
    ): Promise<void> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) headers['x-api-key'] = apiKey;

      const body: Record<string, unknown> = { nodeId, probes };
      if (tenantId) body['tenantId'] = tenantId;

      const res = await fetch(`${endpoint}/probes`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Cloud reportProbes failed: ${res.status}`);
      }
    },
  };
}

// .............................................................................

/** Injectable dependencies for CloudLayer (testing) */
export interface CloudLayerDeps {
  /** Custom HTTP client factory — defaults to real fetch */
  createHttpClient?: CreateCloudHttpClient;
}

type Listener = DiscoveryLayerEvents[DiscoveryLayerEventName];

// .............................................................................

/**
 * Cloud discovery layer — cross-network fallback (Try 2).
 *
 * Registers with a cloud service, periodically polls for peer list and
 * hub assignment, and reports local probe results. The cloud has the full
 * picture across all nodes and **dictates** the hub (unlike broadcast,
 * which uses local election).
 *
 * On startup, registers with the cloud endpoint. If registration fails
 * (endpoint unreachable, auth error), start() returns false and the
 * NetworkManager falls through to the Static layer (Try 3).
 */
/**
 * How soon the first registration retry happens.
 *
 * Short on purpose: the case this exists for is a cloud that is restarting,
 * which is measured in seconds. A node that came up two seconds early should
 * not wait minutes to join the register it is entitled to be in.
 */
const RETRY_MIN_MS = 5_000;

/**
 * The longest a registration retry ever waits.
 *
 * A cloud that has been down for an hour should cost a handful of requests,
 * not thousands — and should still be noticed within a minute of coming back.
 */
const RETRY_MAX_MS = 60_000;

export class CloudLayer implements DiscoveryLayer {
  readonly name = 'cloud';

  private _active = false;
  private _identity: NodeIdentity | null = null;
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending registration retry, when the first attempt did not get through. */
  private _retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long the next retry waits. Doubles, capped at {@link RETRY_MAX_MS}. */
  private _retryDelayMs = 0;
  private _peers = new Map<NodeId, NodeInfo>();
  private _assignedHub: NodeId | null = null;

  /**
   * Whether the cloud is coordinating this domain's hub.
   *
   * False until a response says otherwise, and reset when the layer stops, so
   * a node that loses the cloud returns to organising itself rather than
   * holding a decision nobody is renewing.
   */
  private _cloudCoordinated = false;
  private _listeners = new Map<string, Set<Listener>>();
  private readonly _httpClient: CloudHttpClient;

  // Backoff state
  private _consecutivePollFailures = 0;
  private _basePollIntervalMs = 30000;
  private _currentPollIntervalMs = 30000;
  private _maxBackoffMs = 300000;
  private _reRegisterThreshold = 10;

  /**
   * Create a CloudLayer.
   * @param _config - Cloud configuration (endpoint, apiKey, pollInterval)
   * @param deps - Injectable dependencies for testing
   */
  constructor(
    private readonly _config?: CloudConfig,
    deps?: CloudLayerDeps,
  ) {
    this._httpClient =
      deps?.createHttpClient?.() ?? defaultCreateCloudHttpClient();
  }

  // .........................................................................
  // Lifecycle
  // .........................................................................

  /**
   * Start the cloud layer.
   *
   * 1. Check if cloud is enabled and endpoint configured
   * 2. Register this node with the cloud
   * 3. Process initial peer list and hub assignment
   * 4. Start periodic polling
   * @param identity - This node's identity
   * @returns true if cloud is available, false otherwise
   */
  async start(identity: NodeIdentity): Promise<boolean> {
    // Idempotency: already active → nothing to do
    if (this._active) return true;

    if (this._config?.enabled !== true) {
      return false;
    }

    if (!this._config.endpoint) {
      return false;
    }

    this._identity = identity;

    // Register with cloud
    let response: CloudPeerListResponse;
    try {
      response = await this._httpClient.register(
        this._config.endpoint,
        identity.toNodeInfo(),
        this._config.apiKey,
        this._config.tenantId,
      );
    } catch {
      // **Unreachable now is not unreachable for ever.**
      //
      // This returned `false` and stopped, which is right about the immediate
      // question — the node must not block on the cloud, so it falls through
      // to broadcast and works. It was wrong about every moment after: the
      // only code that retries registration lives in `_poll()`, and `_poll()`
      // never runs unless `start()` reached the end. So one failed call left
      // the layer dead for the life of the process, and the node stayed
      // invisible to the Coordinator while syncing perfectly over the LAN —
      // the state nothing complains about, because everything works.
      //
      // Seen on 2026-09-29: a workstation booted in the three seconds its
      // platform took to restart, got `503` from `/register`, and was still
      // absent from the tenant's topology hours later.
      //
      // So: still `false`, and still falling through to broadcast — and a
      // retry left running behind it. When the cloud answers, the layer
      // activates itself and the node appears where it belongs.
      this._scheduleRegisterRetry(identity);
      return false;
    }

    this._active = true;

    // Initialize backoff state (enforce minimums to prevent tight loops)
    this._basePollIntervalMs = Math.max(
      this._config.pollIntervalMs ?? 30000,
      100,
    );
    this._currentPollIntervalMs = this._basePollIntervalMs;
    this._maxBackoffMs = Math.max(this._config.maxBackoffMs ?? 300000, 100);
    this._reRegisterThreshold = Math.max(
      this._config.reRegisterAfterFailures ?? 10,
      1,
    );
    this._consecutivePollFailures = 0;

    // Process initial response
    this._processResponse(response);

    // Start periodic polling (setTimeout-based for backoff support)
    this._schedulePoll();

    return true;
  }

  /**
   * Keeps trying to register, in the background, until it works.
   *
   * Backs off from {@link RETRY_MIN_MS} to {@link RETRY_MAX_MS} so a cloud
   * that is down for an hour costs a handful of requests rather than
   * thousands, and so a cloud that is merely restarting is picked up within
   * seconds rather than at the next reboot of this node.
   *
   * `unref`'d: a node must not be held alive by its wish to be registered.
   * @param identity - Who to register as. The SAME identity `start` was given,
   *   so a successful retry puts this node in the register once, not twice.
   */
  private _scheduleRegisterRetry(identity: NodeIdentity): void {
    if (this._retryTimer !== null) return;
    this._retryDelayMs = Math.min(
      Math.max(this._retryDelayMs * 2, RETRY_MIN_MS),
      RETRY_MAX_MS,
    );
    const timer = setTimeout(() => {
      this._retryTimer = null;
      void this._retryRegister(identity);
    }, this._retryDelayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this._retryTimer = timer;
  }

  /**
   * One retry attempt. On success the layer starts for real.
   * @param identity - Who to register as.
   */
  private async _retryRegister(identity: NodeIdentity): Promise<void> {
    // Stopped, or started some other way, while this was waiting.
    if (this._active || this._config?.enabled !== true) return;
    const started = await this.start(identity);
    if (!started && this._config?.enabled === true) {
      this._scheduleRegisterRetry(identity);
    }
  }

  /** Stop the layer and clean up resources */
  async stop(): Promise<void> {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    // A retry outliving `stop()` would register a node that has been told to
    // go away, which is worse than not registering one that wants to stay.
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._retryDelayMs = 0;

    // Emit peer-lost for all known peers before cleanup
    if (this._active) {
      for (const [nodeId] of this._peers) {
        this._emit('peer-lost', nodeId);
      }
    }

    this._peers.clear();
    this._assignedHub = null;
    this._cloudCoordinated = false;
    this._active = false;
    this._identity = null;
    this._listeners.clear();
    this._consecutivePollFailures = 0;
    this._currentPollIntervalMs = this._basePollIntervalMs;
  }

  /** Whether this layer is currently active */
  isActive(): boolean {
    return this._active;
  }

  // .........................................................................
  // Peer access
  // .........................................................................

  /** Get all currently known peers from cloud discovery */
  getPeers(): NodeInfo[] {
    return [...this._peers.values()];
  }

  /**
   * Get the hub assigned by the cloud.
   * The cloud **dictates** the hub — it has the full picture.
   */
  getAssignedHub(): NodeId | null {
    return this._assignedHub;
  }

  /**
   * Whether the cloud is coordinating this domain's hub, rather than observing.
   *
   * Only true while the layer is active AND the coordinator says `auto` AND it
   * has actually named a hub. All three matter: a coordinated domain whose
   * cloud has gone away, or which the cloud has not decided about yet, must
   * fall back to the local election rather than sit without a hub. A branch
   * that cannot reach the cloud must not lose its own network.
   * @returns True when the local election should stand down.
   */
  isCloudCoordinated(): boolean {
    return this._active && this._cloudCoordinated && this._assignedHub !== null;
  }

  /** Get current consecutive poll failure count (for diagnostics/testing) */
  getConsecutivePollFailures(): number {
    return this._consecutivePollFailures;
  }

  /** Get current effective poll interval including backoff (for diagnostics/testing) */
  getCurrentPollIntervalMs(): number {
    return this._currentPollIntervalMs;
  }

  // .........................................................................
  // Probe reporting
  // .........................................................................

  /**
   * Report local probe results to the cloud.
   * The cloud uses these to build a connectivity graph and assign hubs.
   * @param probes - Probe results from the local ProbeScheduler
   */
  async reportProbes(probes: PeerProbe[]): Promise<void> {
    /* v8 ignore if -- @preserve */
    if (!this._active || !this._identity || !this._config?.endpoint) return;

    try {
      await this._httpClient.reportProbes(
        this._config.endpoint,
        this._identity.nodeId,
        probes,
        this._config.apiKey,
        this._config.tenantId,
      );
    } catch {
      // Report failed — cloud may be temporarily unreachable, ignore
    }
  }

  // .........................................................................
  // Events
  // .........................................................................

  /**
   * Subscribe to layer events.
   * @param event - Event name
   * @param cb - Callback
   */
  on<E extends DiscoveryLayerEventName>(
    event: E,
    cb: DiscoveryLayerEvents[E],
  ): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb as Listener);
  }

  /**
   * Unsubscribe from layer events.
   * @param event - Event name
   * @param cb - Callback
   */
  off<E extends DiscoveryLayerEventName>(
    event: E,
    cb: DiscoveryLayerEvents[E],
  ): void {
    const set = this._listeners.get(event);
    /* v8 ignore if -- @preserve */
    if (!set) return;
    set.delete(cb as Listener);
  }

  // .........................................................................
  // Internal
  // .........................................................................

  /**
   * Schedule the next poll using setTimeout.
   * Uses the current (possibly backed-off) interval.
   */
  private _schedulePoll(): void {
    this._pollTimer = setTimeout(() => {
      void this._poll()
        .catch(() => {
          // Defensive: ensure polling continues even if a listener throws
        })
        .then(() => {
          /* v8 ignore if -- @preserve */
          if (this._active) this._schedulePoll();
        });
    }, this._currentPollIntervalMs);
  }

  /**
   * Poll the cloud for latest peer list and hub assignment.
   *
   * After many consecutive failures, attempts re-registration instead
   * of a regular poll (the cloud may have expired our registration).
   *
   * On success: resets failure counter and backoff interval.
   * On failure: increments counter and doubles interval (capped at maxBackoffMs).
   */
  private async _poll(): Promise<void> {
    /* v8 ignore if -- @preserve */
    if (!this._identity || !this._config?.endpoint) return;

    // After many consecutive failures, try re-registration
    if (this._consecutivePollFailures >= this._reRegisterThreshold) {
      let response: CloudPeerListResponse;
      try {
        response = await this._httpClient.register(
          this._config.endpoint,
          this._identity.toNodeInfo(),
          this._config.apiKey,
          this._config.tenantId,
        );
      } catch {
        this._consecutivePollFailures++;
        this._currentPollIntervalMs = Math.min(
          this._currentPollIntervalMs * 2,
          this._maxBackoffMs,
        );
        return;
      }

      // HTTP succeeded — reset backoff before processing response
      this._consecutivePollFailures = 0;
      this._currentPollIntervalMs = this._basePollIntervalMs;
      this._processResponse(response);
      return;
    }

    let response: CloudPeerListResponse;
    try {
      response = await this._httpClient.poll(
        this._config.endpoint,
        this._identity.nodeId,
        this._identity.domain,
        this._config.apiKey,
        this._config.tenantId,
      );
    } catch {
      this._consecutivePollFailures++;
      this._currentPollIntervalMs = Math.min(
        this._currentPollIntervalMs * 2,
        this._maxBackoffMs,
      );
      return;
    }

    // HTTP succeeded — reset backoff before processing response
    this._consecutivePollFailures = 0;
    this._currentPollIntervalMs = this._basePollIntervalMs;
    this._processResponse(response);
  }

  /**
   * Process a cloud response: update peers and hub assignment.
   * @param response - The cloud's peer list response
   */
  private _processResponse(response: CloudPeerListResponse): void {
    const currentPeerIds = new Set(this._peers.keys());
    const newPeerIds = new Set<NodeId>();

    // Add/update peers from response
    for (const peer of response.peers) {
      // Never add self to peer table
      if (peer.nodeId === this._identity?.nodeId) continue;

      // Domain isolation: ignore peers from other domains. The cloud scopes
      // by domain server-side, but enforce it client-side too so a stray
      // cross-domain peer never enters discovery, probing, or election —
      // including the deferral logic that reads cloud peers directly.
      if (peer.domain !== this._identity?.domain) continue;

      newPeerIds.add(peer.nodeId);
      const isNew = !this._peers.has(peer.nodeId);
      this._peers.set(peer.nodeId, peer);

      if (isNew) {
        this._emit('peer-discovered', peer);
      }
    }

    // Remove peers no longer in cloud response
    for (const oldId of currentPeerIds) {
      if (!newPeerIds.has(oldId)) {
        this._peers.delete(oldId);
        this._emit('peer-lost', oldId);
      }
    }

    // Update hub assignment
    this._cloudCoordinated = response.hubPolicy === 'auto';
    const previousHub = this._assignedHub;
    this._assignedHub = response.assignedHub;

    if (previousHub !== this._assignedHub) {
      this._emit('hub-assigned', this._assignedHub);
    }
  }

  /**
   * Emit a typed event to all registered listeners.
   * @param event - Event name
   * @param args - Event arguments
   */
  private _emit<E extends DiscoveryLayerEventName>(
    event: E,
    ...args: Parameters<DiscoveryLayerEvents[E]>
  ): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}
