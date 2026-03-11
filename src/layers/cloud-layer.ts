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
}

// .............................................................................

/** Abstraction over HTTP fetch for testability */
export interface CloudHttpClient {
  /**
   * Register this node with the cloud service.
   * @param endpoint - Cloud service base URL
   * @param info - This node's info
   * @param apiKey - Optional API key
   * @returns The peer list response from the cloud
   */
  register(
    endpoint: string,
    info: NodeInfo,
    apiKey?: string,
  ): Promise<CloudPeerListResponse>;

  /**
   * Poll the cloud for the latest peer list and hub assignment.
   * @param endpoint - Cloud service base URL
   * @param nodeId - This node's ID
   * @param domain - This node's domain
   * @param apiKey - Optional API key
   * @returns The peer list response from the cloud
   */
  poll(
    endpoint: string,
    nodeId: NodeId,
    domain: string,
    apiKey?: string,
  ): Promise<CloudPeerListResponse>;

  /**
   * Report probe results to the cloud.
   * @param endpoint - Cloud service base URL
   * @param nodeId - This node's ID
   * @param probes - Probe results to report
   * @param apiKey - Optional API key
   */
  reportProbes(
    endpoint: string,
    nodeId: NodeId,
    probes: PeerProbe[],
    apiKey?: string,
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
    ): Promise<CloudPeerListResponse> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(`${endpoint}/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify(info),
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
    ): Promise<CloudPeerListResponse> {
      const headers: Record<string, string> = {};
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const params = new URLSearchParams({ nodeId, domain });
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
    ): Promise<void> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const res = await fetch(`${endpoint}/probes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ nodeId, probes }),
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
export class CloudLayer implements DiscoveryLayer {
  readonly name = 'cloud';

  private _active = false;
  private _identity: NodeIdentity | null = null;
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _peers = new Map<NodeId, NodeInfo>();
  private _assignedHub: NodeId | null = null;
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
      );
    } catch {
      // Cloud unreachable — fall through to static
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

  /** Stop the layer and clean up resources */
  async stop(): Promise<void> {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }

    // Emit peer-lost for all known peers before cleanup
    if (this._active) {
      for (const [nodeId] of this._peers) {
        this._emit('peer-lost', nodeId);
      }
    }

    this._peers.clear();
    this._assignedHub = null;
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
