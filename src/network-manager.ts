// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeId, NodeInfo } from './types/node-info.ts';
import type { NetworkConfig } from './types/network-config.ts';
import type {
  NetworkTopology,
  FormedBy,
  NodeRole,
} from './types/network-topology.ts';
import type {
  TopologyChangedEvent,
  RoleChangedEvent,
  HubChangedEvent,
} from './types/network-events.ts';
import { NodeIdentity } from './identity/node-identity.ts';
import { ManualLayer } from './layers/manual-layer.ts';
import { StaticLayer } from './layers/static-layer.ts';
import { PeerTable } from './peer-table.ts';

// .............................................................................

/** Events emitted by NetworkManager */
export interface NetworkManagerEvents {
  'topology-changed': (event: TopologyChangedEvent) => void;
  'role-changed': (event: RoleChangedEvent) => void;
  'hub-changed': (event: HubChangedEvent) => void;
  'peer-joined': (peer: NodeInfo) => void;
  'peer-left': (nodeId: string) => void;
}

/** Valid event names for NetworkManager */
export type NetworkManagerEventName = keyof NetworkManagerEvents;

type Listener = NetworkManagerEvents[NetworkManagerEventName];

// .............................................................................

/**
 * Central orchestrator for network topology.
 *
 * Starts all configured discovery layers, merges peer tables,
 * applies the fallback cascade, and emits topology events.
 *
 * Currently supports ManualLayer + StaticLayer (Epic 2 shell).
 * Broadcast and Cloud layers will be added in later epics.
 */
export class NetworkManager {
  private _identity: NodeIdentity | null = null;
  private _running = false;

  /** Always-present manual override layer */
  private readonly _manualLayer = new ManualLayer();

  /** Try 3: Static config fallback */
  private readonly _staticLayer: StaticLayer;

  /** Merged peer table */
  private readonly _peerTable = new PeerTable();

  /** Event listeners */
  private _listeners = new Map<string, Set<Listener>>();

  /** Current topology snapshot */
  private _currentHubId: NodeId | null = null;
  private _currentRole: NodeRole = 'unassigned';
  private _formedBy: FormedBy = 'static';

  /**
   * Create a NetworkManager.
   * @param _config - Network configuration
   */
  constructor(private readonly _config: NetworkConfig) {
    this._staticLayer = new StaticLayer(this._config.static);
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
    });

    this._peerTable.setSelfId(this._identity.nodeId);

    // Attach layers to peer table
    this._peerTable.attachLayer(this._manualLayer);
    this._peerTable.attachLayer(this._staticLayer);

    // Listen for peer changes to trigger re-evaluation
    this._peerTable.on('peer-joined', (peer) => {
      this._emit('peer-joined', peer);
      this._recomputeTopology();
    });
    this._peerTable.on('peer-left', (nodeId) => {
      this._emit('peer-left', nodeId);
      this._recomputeTopology();
    });

    // Listen for hub-assigned events from layers
    this._manualLayer.on('hub-assigned', () => {
      this._recomputeTopology();
    });
    this._staticLayer.on('hub-assigned', () => {
      this._recomputeTopology();
    });

    // Start layers
    await this._manualLayer.start(this._identity);
    await this._staticLayer.start(this._identity);

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

    await this._manualLayer.stop();
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
      nodes,
      probes: [],
      myRole: this._currentRole,
    };
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
   *   2. [future] Broadcast peers → election (most autonomous)
   *   3. [future] Cloud assignment (sees full picture)
   *   4. Static config (last resort)
   *   5. Nothing → unassigned
   */
  private _computeHub(): { hubId: NodeId | null; formedBy: FormedBy } {
    // Override: manual always wins
    const manualHub = this._manualLayer.getAssignedHub();
    if (manualHub) {
      return { hubId: manualHub, formedBy: 'manual' };
    }

    // Try 1: Broadcast — not yet implemented (Epic 4)
    // Try 2: Cloud — not yet implemented (Epic 5)

    // Try 3: Static — last resort
    if (this._staticLayer.isActive()) {
      const staticHub = this._staticLayer.getAssignedHub();
      /* v8 ignore else -- @preserve */
      if (staticHub) {
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
      this._emit('hub-changed', {
        previousHub,
        currentHub: this._currentHubId,
      });
    }

    // Emit role-changed if role changed
    if (previousRole !== this._currentRole) {
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
