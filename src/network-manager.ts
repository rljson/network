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
import {
  ProbeListener,
  type ProbeListenerDeps,
} from './probing/probe-listener.ts';
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
  /** Injectable dependencies for ProbeListener (e.g. mock TCP server) */
  probeListenerDeps?: ProbeListenerDeps;
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

  /** TCP listener that answers incoming probes from other nodes */
  private readonly _probeListener: ProbeListener;

  /** Event listeners */
  private _listeners = new Map<string, Set<Listener>>();

  /**
   * Nodes temporarily excluded from hub election.
   * Maps nodeId to expiry timestamp (Date.now() + durationMs).
   */
  private _excludedNodes = new Map<NodeId, number>();

  /** Current topology snapshot */
  private _currentHubId: NodeId | null = null;
  private _currentRole: NodeRole = 'unassigned';
  private _formedBy: FormedBy = 'static';

  /** Whether probing (and thus the probe listener) is enabled. Set in start(). */
  private _probingEnabled = false;

  /**
   * Port the probe listener binds to. It is released for the application's
   * hub server while this node is the hub, then reacquired afterwards.
   */
  private _probePort = 0;

  /** Guards against overlapping probe-listener start/stop operations. */
  private _probeListenerBusy = false;

  /**
   * When true, the next election ignores incumbent advantage. Set by
   * clearOverride so the override target doesn't keep incumbency.
   */
  private _suppressIncumbent = false;

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
    this._probeListener = new ProbeListener(options?.probeListenerDeps);
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

    // Bind the probe listener first (if probing is enabled) so that the
    // node's advertised port reflects the actual bound port — important
    // when the caller passes port 0 to request an ephemeral port.
    const probingEnabled = this._config.probing?.enabled !== false;
    let advertisedPort = this._config.port;
    if (probingEnabled) {
      advertisedPort = await this._probeListener.start(this._config.port);
    }
    this._probingEnabled = probingEnabled;
    this._probePort = advertisedPort;

    // Create node identity
    this._identity = await NodeIdentity.create({
      domain: this._config.domain,
      port: advertisedPort,
      identityDir: this._config.identityDir,
    });

    this._peerTable.setSelfId(this._identity.nodeId);
    // Domain isolation: peers from other domains are never merged, so nodes
    // in different domains don't discover each other and election only ever
    // considers same-domain candidates.
    this._peerTable.setSelfDomain(this._identity.domain);

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
        // Upload probes to the cloud coordinator (if configured) so it can
        // build a connectivity graph and elect hubs across the fleet.
        // No-op when CloudLayer is inactive.
        void this._cloudLayer.reportProbes(probes);
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
    await this._probeListener.stop();
    await this._manualLayer.stop();
    await this._broadcastLayer.stop();
    await this._cloudLayer.stop();
    await this._staticLayer.stop();

    this._peerTable.clear();
    this._listeners.clear();
    this._excludedNodes.clear();

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
   *
   * Also clears all election exclusions so that the natural election
   * can consider every reachable node — including one that was
   * temporarily excluded during the override cycle (e.g. a hub that
   * failed its self-check).
   *
   * The next election runs without incumbent advantage so the
   * override target does not keep incumbency.
   */
  clearOverride(): void {
    this._suppressIncumbent = true;
    this._manualLayer.clearOverride();
    this.clearExclusions();
  }

  /**
   * Clear all election exclusions immediately.
   *
   * Use this when the conditions that caused the exclusion no longer
   * apply (e.g. after clearing a manual override).
   */
  clearExclusions(): void {
    if (this._excludedNodes.size > 0) {
      this._log(
        'election',
        `Cleared ${this._excludedNodes.size} election exclusion(s)`,
      );
      this._excludedNodes.clear();
      this._recomputeTopology();
    }
  }

  /**
   * Temporarily exclude a node from hub election.
   *
   * Used by hub self-check: when a hub discovers it cannot accept
   * inbound connections (zero clients after timeout), it excludes
   * itself so the next election picks a different node.
   * The exclusion expires after {@link durationMs} to allow recovery
   * (e.g. if the firewall is fixed).
   * @param nodeId - The node to exclude
   * @param durationMs - How long to exclude (milliseconds)
   */
  excludeFromElection(nodeId: NodeId, durationMs: number): void {
    this._excludedNodes.set(nodeId, Date.now() + durationMs);
    this._log(
      'election',
      `Excluded ${nodeId.slice(0, 8)}... from election for ${durationMs}ms`,
    );
    this._recomputeTopology();
  }

  /**
   * Check whether a node is currently excluded from election.
   * @param nodeId - The node to check
   * @returns true if the node is excluded from election
   */
  isExcludedFromElection(nodeId: NodeId): boolean {
    const expiry = this._excludedNodes.get(nodeId);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) {
      this._excludedNodes.delete(nodeId);
      return false;
    }
    return true;
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
      // Build candidates: self + all known peers, excluding temporarily
      // excluded nodes (e.g. nodes that failed hub self-check).
      const candidates: NodeInfo[] = [
        this._identity.toNodeInfo(),
        ...this._peerTable.getPeers(),
      ].filter((c) => !this.isExcludedFromElection(c.nodeId));

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
      //
      // After clearOverride, _suppressIncumbent is true so we pass
      // null — the override target should not keep incumbency.
      const effectiveIncumbent = this._suppressIncumbent
        ? null
        : this._currentHubId;
      this._suppressIncumbent = false;

      const result = electHub(
        candidates,
        probes,
        effectiveIncumbent,
        this._identity.nodeId,
      );
      /* v8 ignore else -- @preserve */
      if (result.hubId) {
        // When election elects self (only self is reachable) but a real peer
        // (from broadcast or cloud — NOT synthetic static peers) with earlier
        // startedAt exists that has NEVER been successfully probed, defer
        // self-election.  Those peers are likely still starting up (port 3000
        // not open yet).  Only the earliest node self-promotes; others wait
        // for it to open its hub transport, then join as clients.
        //
        // We check both broadcast AND cloud peers because a node discovered
        // via cloud with earlier startedAt should also prevent self-election.
        // Static peers are excluded: they use synthetic startedAt=0 which
        // would always trigger false deferrals.
        //
        // This does NOT block re-election after a hub crash: a crashed peer
        // was previously reachable (hasEverBeenReachable === true), so the
        // deferral does not trigger.
        //
        // When deferred, we fall through to the cloud/static cascade so the
        // node can still join as client under a cloud-assigned hub instead
        // of becoming unassigned.
        if (
          result.hubId === this._identity.nodeId &&
          result.reason !== 'incumbent'
        ) {
          const selfInfo = this._identity.toNodeInfo();
          const realPeers = [
            ...this._broadcastLayer.getPeers(),
            ...this._cloudLayer.getPeers(),
          ];
          const hasUntestedEarlierPeer = realPeers.some(
            (p) =>
              !this._probeScheduler.hasEverBeenReachable(p.nodeId) &&
              (p.startedAt < selfInfo.startedAt ||
                /* v8 ignore start -- @preserve */
                (p.startedAt === selfInfo.startedAt &&
                  p.nodeId < selfInfo.nodeId)),
            /* v8 ignore stop -- @preserve */
          );
          if (hasUntestedEarlierPeer) {
            this._log(
              'election',
              `Deferring self-election: untested earlier peer exists`,
            );
            // Fall through to cloud/static cascade instead of self-electing.
            // Do NOT return here — let the cascade handle it.
          } else {
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
        } else {
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
    }

    // Try 2: Cloud — dictates hub (cloud has the full picture)
    if (this._cloudLayer.isActive()) {
      const cloudHub = this._cloudLayer.getAssignedHub();
      if (cloudHub) {
        if (this._isKnownUnreachableOrExcluded(cloudHub)) {
          this._log(
            'election',
            `Rejecting cloud hub ${cloudHub.slice(0, 8)}... ` +
              `(unreachable or excluded)`,
          );
        } else {
          this._log(
            'election',
            `Cloud assigned hub: ${cloudHub.slice(0, 8)}...`,
          );
          return { hubId: cloudHub, formedBy: 'cloud' };
        }
      }
    }

    // Try 3: Static — last resort
    if (this._staticLayer.isActive()) {
      const staticHub = this._staticLayer.getAssignedHub();
      /* v8 ignore else -- @preserve */
      if (staticHub) {
        if (this._isKnownUnreachableOrExcluded(staticHub)) {
          this._log(
            'election',
            `Rejecting static hub ${staticHub.slice(0, 8)}... ` +
              `(unreachable or excluded)`,
          );
        } else {
          this._log('election', `Static hub: ${staticHub.slice(0, 8)}...`);
          return { hubId: staticHub, formedBy: 'static' };
        }
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

    // Align the probe listener with the new role: it shares its port with
    // the application's hub server, so it must yield while this node is hub.
    this._ensureProbeListenerState();

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
   * Keep the probe listener's lifecycle aligned with this node's role.
   *
   * The probe listener and the application's hub server share the same
   * configured port. While this node is the hub, its hub server occupies
   * that port and already answers TCP probes, so the probe listener must
   * release it — otherwise the hub server hits `EADDRINUSE` and degrades,
   * and peers probe the empty-reply stub instead of the real hub. While
   * this node is NOT the hub, nothing else holds the port, so the probe
   * listener provides the TCP target.
   *
   * Called after every topology recompute, so it is idempotent and
   * self-healing: a transient `EADDRINUSE` while the hub server is still
   * closing simply resolves on the next recompute.
   */
  private _ensureProbeListenerState(): void {
    if (!this._probingEnabled || this._probeListenerBusy) return;
    const shouldRun = this._currentRole !== 'hub';
    if (shouldRun === this._probeListener.isRunning()) return;
    this._probeListenerBusy = true;
    const op = shouldRun
      ? this._acquireProbeListener()
      : this._releaseProbeListener();
    void op.finally(() => {
      this._probeListenerBusy = false;
    });
  }

  /** Stop the probe listener so the hub server can bind the shared port. */
  private async _releaseProbeListener(): Promise<void> {
    await this._probeListener.stop();
    this._log('probe', 'Released probe port — hub server now answers probes');
  }

  /** Restart the probe listener on the shared port once this node is no longer hub. */
  private async _acquireProbeListener(): Promise<void> {
    try {
      await this._probeListener.start(this._probePort);
      this._log('probe', `Reacquired probe port ${this._probePort}`);
    } catch (err) {
      // The previous hub server may still be releasing the port — the next
      // topology recompute retries via _ensureProbeListenerState.
      this._log(
        'probe',
        `Probe port ${this._probePort} not free yet, will retry: ${String(err)}`,
      );
    }
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

    // If hub is self, resolve from own identity (peer table excludes self)
    if (this._identity && this._currentHubId === this._identity.nodeId) {
      const selfInfo = this._identity.toNodeInfo();
      /* v8 ignore next -- @preserve */
      const ip = selfInfo.localIps[0] ?? 'unknown';
      return `${ip}:${selfInfo.port}`;
    }

    return null;
  }

  /**
   * Check if a node is known to be unreachable (via probes) or
   * temporarily excluded from election.
   * Returns false for self (always reachable) and for unknown nodes
   * (no probe data — they might be reachable).
   * @param nodeId - The node to check
   */
  private _isKnownUnreachableOrExcluded(nodeId: NodeId): boolean {
    // Self is always reachable
    if (this._identity && nodeId === this._identity.nodeId) return false;

    // Check exclusion list
    if (this.isExcludedFromElection(nodeId)) return true;

    // Check probe results — only reject if probed AND unreachable
    const probe = this._probeScheduler.getProbe(nodeId);
    return probe !== undefined && !probe.reachable;
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
