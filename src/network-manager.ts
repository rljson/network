// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import { electHub } from './election/hub-election.ts';
import { NodeIdentity } from './identity/node-identity.ts';
import {
  BroadcastLayer,
  type BroadcastLayerDeps,
} from './layers/broadcast-layer.ts';
import { CloudLayer, type CloudLayerDeps } from './layers/cloud-layer.ts';
import { ManualLayer } from './layers/manual-layer.ts';
import { StaticLayer } from './layers/static-layer.ts';
import { PeerTable } from './peer-table.ts';
import { ProbeScheduler, type ProbeFn } from './probing/probe-scheduler.ts';
import type { NetworkConfig } from './types/network-config.ts';
import type {
  HubChangedEvent,
  NetworkLogEntry,
  RoleChangedEvent,
  TopologyChangedEvent,
} from './types/network-events.ts';
import type {
  FormedBy,
  NetworkTopology,
  NodeRole,
} from './types/network-topology.ts';
import type { NodeId, NodeInfo } from './types/node-info.ts';

// .............................................................................

/** Events emitted by NetworkManager */
export interface NetworkManagerEvents {
  'topology-changed': (event: TopologyChangedEvent) => void;
  'role-changed': (event: RoleChangedEvent) => void;
  'hub-changed': (event: HubChangedEvent) => void;
  'peer-joined': (peer: NodeInfo) => void;
  'peer-left': (nodeId: string) => void;
  log: (entry: NetworkLogEntry) => void;
}

/** Valid event names for NetworkManager */
export type NetworkManagerEventName = keyof NetworkManagerEvents;

type Listener = NetworkManagerEvents[NetworkManagerEventName];

/** Options for NetworkManager constructor */
export interface NetworkManagerOptions {
  /** Custom probe function (e.g. for testing) */
  probeFn?: ProbeFn;
  /**
   * Number of consecutive probe failures before declaring a peer
   * unreachable (default: 3). Passed through to ProbeScheduler.
   */
  failThreshold?: number;
  /** Injectable dependencies for BroadcastLayer (e.g. mock sockets) */
  broadcastDeps?: BroadcastLayerDeps;
  /** Injectable dependencies for CloudLayer (e.g. mock HTTP client) */
  cloudDeps?: CloudLayerDeps;
}

// .............................................................................

/**
 * Central orchestrator for network topology.
 *
 * Starts all configured discovery layers, merges peer tables,
 * applies the fallback cascade, and emits topology events.
 *
 * Supports ManualLayer + StaticLayer + hub election via probing.
 * Broadcast and Cloud layers will be added in later epics.
 */
export class NetworkManager {
  private _identity: NodeIdentity | null = null;
  private _running = false;

  /** Always-present manual override layer */
  private readonly _manualLayer = new ManualLayer();

  /** Try 1: UDP broadcast discovery */
  private readonly _broadcastLayer: BroadcastLayer;

  /** Try 2: Cloud discovery fallback */
  private readonly _cloudLayer: CloudLayer;

  /** Try 3: Static config fallback */
  private readonly _staticLayer: StaticLayer;

  /** Merged peer table */
  private readonly _peerTable = new PeerTable();

  /** Probe scheduler for reachability checking */
  private readonly _probeScheduler: ProbeScheduler;

  /** Event listeners */
  private _listeners = new Map<string, Set<Listener>>();

  /** Current topology snapshot */
  private _currentHubId: NodeId | null = null;
  private _currentRole: NodeRole = 'unassigned';
  private _formedBy: FormedBy = 'static';

  /**
   * Create a NetworkManager.
   * @param _config - Network configuration
   * @param options - Optional overrides (e.g. custom probe function)
   */
  constructor(
    private readonly _config: NetworkConfig,
    options?: NetworkManagerOptions,
  ) {
    this._broadcastLayer = new BroadcastLayer(
      this._config.broadcast,
      options?.broadcastDeps,
    );
    this._cloudLayer = new CloudLayer(this._config.cloud, options?.cloudDeps);
    this._staticLayer = new StaticLayer(this._config.static);
    const probingConfig = this._config.probing;
    this._probeScheduler = new ProbeScheduler({
      intervalMs: probingConfig?.intervalMs ?? 10000,
      timeoutMs: probingConfig?.timeoutMs ?? 2000,
      probeFn: options?.probeFn,
      failThreshold: options?.failThreshold,
    });
  }

  // .........................................................................
  // Lifecycle
  // .........................................................................

  /**
   * Start the network manager.
   *
   * Creates node identity, starts all layers, attaches to peer table,
   * and performs initial hub computation.
   */
  async start(): Promise<void> {
    if (this._running) return;

    // Create node identity
    this._identity = await NodeIdentity.create({
      domain: this._config.domain,
      port: this._config.port,
      identityDir: this._config.identityDir,
    });

    this._peerTable.setSelfId(this._identity.nodeId);

    // Attach layers to peer table
    this._peerTable.attachLayer(this._manualLayer);
    this._peerTable.attachLayer(this._broadcastLayer);
    this._peerTable.attachLayer(this._cloudLayer);
    this._peerTable.attachLayer(this._staticLayer);

    // Listen for peer changes to trigger re-evaluation
    this._peerTable.on('peer-joined', (peer) => {
      /* v8 ignore next -- @preserve */
      const ip = peer.localIps[0] ?? '?';
      this._log(
        'peer',
        `Joined: ${peer.hostname} (${peer.nodeId.slice(0, 8)}...) ` +
          `${ip}:${peer.port}, ` +
          `startedAt: ${new Date(peer.startedAt).toISOString()}`,
      );
      this._emit('peer-joined', peer);
      // Update probe scheduler with new peer list
      this._probeScheduler.setPeers(this._peerTable.getPeers());
      // Trigger immediate probe when a broadcast peer joins so election
      // can resolve dual-hub quickly instead of waiting for the next
      // scheduled cycle (10s default).  Only for broadcast peers —
      // static/cloud peers must not bypass the fallback cascade.
      const broadcastPeers = this._broadcastLayer.getPeers();
      if (broadcastPeers.some((bp) => bp.nodeId === peer.nodeId)) {
        void this._probeScheduler.runOnce();
      }
      this._recomputeTopology();
    });
    this._peerTable.on('peer-left', (nodeId) => {
      this._log('peer', `Left: ${nodeId.slice(0, 8)}...`);
      this._emit('peer-left', nodeId);
      // Update probe scheduler with new peer list
      this._probeScheduler.setPeers(this._peerTable.getPeers());
      this._recomputeTopology();
    });

    // Listen for hub-assigned events from layers
    this._manualLayer.on('hub-assigned', () => {
      this._recomputeTopology();
    });
    // Broadcast layer never emits hub-assigned (getAssignedHub returns null),
    // but we subscribe for completeness if the layer evolves in the future.
    /* v8 ignore next -- @preserve */
    this._broadcastLayer.on('hub-assigned', () => this._recomputeTopology());
    this._cloudLayer.on('hub-assigned', () => {
      this._recomputeTopology();
    });
    this._staticLayer.on('hub-assigned', () => {
      this._recomputeTopology();
    });

    // Listen for probe updates to trigger re-election
    this._probeScheduler.on('probes-updated', () => {
      const probes = this._probeScheduler.getProbes();
      if (probes.length > 0) {
        const reachable = probes.filter((p) => p.reachable).length;
        const details = probes
          .map((p) => {
            const peer = this._peerTable.getPeer(p.toNodeId);
            /* v8 ignore next -- @preserve */
            const name = peer?.hostname ?? p.toNodeId.slice(0, 8);
            return p.reachable
              ? `${name}:OK(${p.latencyMs}ms)`
              : `${name}:FAIL`;
          })
          .join(', ');
        this._log(
          'probe',
          `Cycle: ${reachable}/${probes.length} reachable [${details}]`,
        );
      }
      this._recomputeTopology();
    });

    // Forward probe state transitions as log events
    this._probeScheduler.on('peer-reachable', (nodeId, probe) => {
      const peer = this._peerTable.getPeer(nodeId);
      /* v8 ignore next -- @preserve */
      const name = peer?.hostname ?? nodeId.slice(0, 8);
      this._log('probe', `${name} became REACHABLE (${probe.latencyMs}ms)`);
    });
    this._probeScheduler.on('peer-unreachable', (nodeId) => {
      const peer = this._peerTable.getPeer(nodeId);
      /* v8 ignore next -- @preserve */
      const name = peer?.hostname ?? nodeId.slice(0, 8);
      this._log('probe', `${name} became UNREACHABLE`);
    });

    // Start layers (cascade priority: broadcast > cloud > static)
    await this._manualLayer.start(this._identity);
    await this._broadcastLayer.start(this._identity);
    await this._cloudLayer.start(this._identity);
    await this._staticLayer.start(this._identity);

    // Start probe scheduler if probing is enabled
    const probingEnabled = this._config.probing?.enabled !== false;
    if (probingEnabled) {
      this._probeScheduler.setPeers(this._peerTable.getPeers());
      this._probeScheduler.start(this._identity.nodeId);
    }

    this._running = true;

    // Initial hub computation
    this._recomputeTopology();
  }

  /**
   * Stop the network manager.
   *
   * Stops all layers and clears state.
   */
  async stop(): Promise<void> {
    if (!this._running) return;

    this._probeScheduler.stop();
    await this._manualLayer.stop();
    await this._broadcastLayer.stop();
    await this._cloudLayer.stop();
    await this._staticLayer.stop();

    this._peerTable.clear();
    this._listeners.clear();

    this._currentHubId = null;
    this._currentRole = 'unassigned';
    this._running = false;
  }

  /** Whether the manager is currently running */
  isRunning(): boolean {
    return this._running;
  }

  // .........................................................................
  // Topology access
  // .........................................................................

  /**
   * Get the current topology snapshot.
   * @returns The current network topology
   */
  getTopology(): NetworkTopology {
    const nodes = new Map<string, NodeInfo>();
    for (const peer of this._peerTable.getPeers()) {
      nodes.set(peer.nodeId, peer);
    }
    // Include self
    /* v8 ignore else -- @preserve */
    if (this._identity) {
      const selfInfo = this._identity.toNodeInfo();
      nodes.set(selfInfo.nodeId, selfInfo);
    }

    return {
      domain: this._config.domain,
      hubNodeId: this._currentHubId,
      hubAddress: this._resolveHubAddress(),
      formedBy: this._formedBy,
      formedAt: Date.now(),
      nodes: Object.fromEntries(nodes),
      probes: this._probeScheduler.getProbes(),
      myRole: this._currentRole,
    };
  }

  /**
   * Get the probe scheduler for direct access to probe results.
   * @returns The ProbeScheduler instance
   */
  getProbeScheduler(): ProbeScheduler {
    return this._probeScheduler;
  }

  /**
   * Get this node's identity.
   * Throws if called before start().
   */
  getIdentity(): NodeIdentity {
    /* v8 ignore if -- @preserve */
    if (!this._identity) {
      throw new Error('NetworkManager not started');
    }
    return this._identity;
  }

  // .........................................................................
  // Manual override
  // .........................................................................

  /**
   * Manually assign a hub node, overriding the cascade.
   * @param nodeId - The node to designate as hub
   */
  assignHub(nodeId: NodeId): void {
    this._manualLayer.assignHub(nodeId);
  }

  /**
   * Clear the manual hub override, returning to cascade logic.
   */
  clearOverride(): void {
    this._manualLayer.clearOverride();
  }

  // .........................................................................
  // Events
  // .........................................................................

  /**
   * Subscribe to network manager events.
   * @param event - Event name
   * @param cb - Callback
   */
  on<E extends NetworkManagerEventName>(
    event: E,
    cb: NetworkManagerEvents[E],
  ): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb as Listener);
  }

  /**
   * Unsubscribe from network manager events.
   * @param event - Event name
   * @param cb - Callback
   */
  off<E extends NetworkManagerEventName>(
    event: E,
    cb: NetworkManagerEvents[E],
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
   * Compute the hub using the fallback cascade.
   *
   * Priority:
   *   1. Manual override (human knows best)
   *   2. Election among probed peers (most autonomous)
   *      - formedBy 'broadcast' if broadcast layer provided peers
   *      - formedBy 'election' otherwise
   *   3. Cloud assignment (sees full picture, dictates hub)
   *   4. Static config (last resort)
   *   5. Nothing → unassigned
   */
  private _computeHub(): { hubId: NodeId | null; formedBy: FormedBy } {
    // Override: manual always wins
    const manualHub = this._manualLayer.getAssignedHub();
    if (manualHub) {
      this._log('election', `Manual override: hub=${manualHub.slice(0, 8)}...`);
      return { hubId: manualHub, formedBy: 'manual' };
    }

    // Try 1+2: Election among probed peers
    // If we have probe results, use election algorithm
    const probes = this._probeScheduler.getProbes();
    if (probes.length > 0 && this._identity) {
      // Build candidates: self + all known peers
      const candidates: NodeInfo[] = [
        this._identity.toNodeInfo(),
        ...this._peerTable.getPeers(),
      ];

      // Self-incumbent advantage: when this node IS the current hub,
      // keep it as hub via incumbent status.  Self is always reachable,
      // so the incumbent check in electHub() always passes.
      //
      // This is critical because TCP probes only reach the hub (port
      // 3000).  Client nodes never open port 3000, so hub-side probes
      // always fail for clients — without incumbent advantage the hub
      // would re-elect every cycle, creating instability.
      //
      // The startup race (two nodes self-electing simultaneously) is
      // handled separately by the deferral logic below (Fix 3), which
      // ensures only the earliest-startedAt node self-promotes before
      // any incumbent exists.
      const effectiveIncumbent = this._currentHubId;

      const result = electHub(
        candidates,
        probes,
        effectiveIncumbent,
        this._identity.nodeId,
      );
      /* v8 ignore else -- @preserve */
      if (result.hubId) {
        // When election elects self (only self is reachable) but broadcast
        // peers with earlier startedAt exist that have NEVER been successfully
        // probed, defer self-election.  Those peers are likely still starting
        // up (port 3000 not open yet).  Only the earliest node self-promotes;
        // others wait for it to open its hub transport, then join as clients.
        //
        // This does NOT block re-election after a hub crash: a crashed peer
        // was previously reachable (hasEverBeenReachable === true), so the
        // deferral does not trigger.
        if (
          result.hubId === this._identity.nodeId &&
          result.reason !== 'incumbent'
        ) {
          const selfInfo = this._identity.toNodeInfo();
          const broadcastPeers = this._broadcastLayer.getPeers();
          const hasUntestedEarlierPeer = broadcastPeers.some(
            (p) =>
              !this._probeScheduler.hasEverBeenReachable(p.nodeId) &&
              (p.startedAt < selfInfo.startedAt ||
                /* v8 ignore next -- @preserve */
                (p.startedAt === selfInfo.startedAt &&
                  p.nodeId < selfInfo.nodeId)),
          );
          if (hasUntestedEarlierPeer) {
            this._log(
              'election',
              `Deferring self-election: untested earlier broadcast peer exists`,
            );
            // Don't self-elect — wait for the rightful winner to start
            return { hubId: null, formedBy: 'election' };
          }
        }

        // Determine formedBy: 'broadcast' if broadcast layer contributed peers
        const formedBy: FormedBy =
          this._broadcastLayer.isActive() &&
          this._broadcastLayer.getPeers().length > 0
            ? 'broadcast'
            : 'election';
        this._log(
          'election',
          `Elected: ${result.hubId.slice(0, 8)}... ` +
            `(reason: ${result.reason}, formedBy: ${formedBy})`,
        );
        return { hubId: result.hubId, formedBy };
      }
    }

    // Try 2: Cloud — dictates hub (cloud has the full picture)
    if (this._cloudLayer.isActive()) {
      const cloudHub = this._cloudLayer.getAssignedHub();
      if (cloudHub) {
        this._log('election', `Cloud assigned hub: ${cloudHub.slice(0, 8)}...`);
        return { hubId: cloudHub, formedBy: 'cloud' };
      }
    }

    // Try 3: Static — last resort
    if (this._staticLayer.isActive()) {
      const staticHub = this._staticLayer.getAssignedHub();
      /* v8 ignore else -- @preserve */
      if (staticHub) {
        this._log('election', `Static hub: ${staticHub.slice(0, 8)}...`);
        return { hubId: staticHub, formedBy: 'static' };
      }
    }

    // Nothing worked
    return { hubId: null, formedBy: 'static' };
  }

  /**
   * Recompute topology and emit events if anything changed.
   */
  private _recomputeTopology(): void {
    const { hubId, formedBy } = this._computeHub();
    const previousHub = this._currentHubId;
    const previousRole = this._currentRole;

    this._currentHubId = hubId;
    this._formedBy = formedBy;

    // Determine role
    if (!hubId) {
      this._currentRole = 'unassigned';
    } else if (this._identity && hubId === this._identity.nodeId) {
      this._currentRole = 'hub';
    } else {
      this._currentRole = 'client';
    }

    // Emit hub-changed if hub changed
    if (previousHub !== this._currentHubId) {
      this._log(
        'topology',
        `Hub changed: ${previousHub?.slice(0, 8) ?? 'none'} → ` +
          `${this._currentHubId?.slice(0, 8) ?? 'none'} (formedBy: ${formedBy})`,
      );
      this._emit('hub-changed', {
        previousHub,
        currentHub: this._currentHubId,
      });
    }

    // Emit role-changed if role changed
    if (previousRole !== this._currentRole) {
      this._log(
        'topology',
        `Role changed: ${previousRole} → ${this._currentRole}`,
      );
      this._emit('role-changed', {
        previous: previousRole,
        current: this._currentRole,
      });
    }

    // Always emit topology-changed
    this._emit('topology-changed', {
      topology: this.getTopology(),
    });
  }

  /**
   * Resolve the hub address ("ip:port") from the current hub.
   * Uses static config's hubAddress if the hub is from static layer.
   */
  private _resolveHubAddress(): string | null {
    if (!this._currentHubId) return null;

    // If static layer provided the hub, use its raw address
    if (this._formedBy === 'static' && this._staticLayer.getHubAddress()) {
      return this._staticLayer.getHubAddress();
    }

    // If cloud layer provided the hub, resolve from peer table
    // (cloud peers have full NodeInfo with localIps and port)

    // Otherwise, try to resolve from peer table
    const peer = this._peerTable.getPeer(this._currentHubId);
    if (peer) {
      /* v8 ignore next -- @preserve */
      const ip = peer.localIps[0] ?? 'unknown';
      return `${ip}:${peer.port}`;
    }

    return null;
  }

  /**
   * Emit a structured log event for internal state visibility.
   * @param category - The log category
   * @param message - The log message
   */
  private _log(category: NetworkLogEntry['category'], message: string): void {
    this._emit('log', { category, message });
  }

  /**
   * Emit a typed event.
   * @param event - Event name
   * @param args - Event arguments
   */
  private _emit<E extends NetworkManagerEventName>(
    event: E,
    ...args: Parameters<NetworkManagerEvents[E]>
  ): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}
