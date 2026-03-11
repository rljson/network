// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeId, NodeInfo } from '../types/node-info.ts';
import type { StaticConfig } from '../types/network-config.ts';
import type { NodeIdentity } from '../identity/node-identity.ts';
import type {
  DiscoveryLayer,
  DiscoveryLayerEventName,
  DiscoveryLayerEvents,
} from './discovery-layer.ts';

// .............................................................................

type Listener = DiscoveryLayerEvents[DiscoveryLayerEventName];

/**
 * Static discovery layer — last resort fallback (Try 3).
 *
 * Reads a hardcoded `hubAddress` from config. If set, produces a synthetic
 * peer for the hub and returns it as the assigned hub. If not set, `start()`
 * returns false.
 *
 * Static config is not a dead end — if a more autonomous layer (broadcast,
 * cloud) starts producing results, the NetworkManager upgrades automatically.
 */
export class StaticLayer implements DiscoveryLayer {
  readonly name = 'static';
  private _active = false;
  private _hubAddress: string | null = null;
  private _hubNodeId: NodeId | null = null;
  private _syntheticPeer: NodeInfo | null = null;
  private _listeners = new Map<string, Set<Listener>>();

  /**
   * Create a StaticLayer.
   * @param _config - Static config with optional hubAddress
   */
  constructor(private readonly _config?: StaticConfig) {}

  /**
   * Start the layer. Returns false if no hubAddress is configured.
   * @param identity - This node's identity (used for domain info on synthetic peer)
   */
  async start(identity: NodeIdentity): Promise<boolean> {
    const hubAddress = this._config?.hubAddress;
    if (!hubAddress) {
      return false;
    }

    this._hubAddress = hubAddress;

    // Generate a deterministic nodeId from the hubAddress
    // (we don't know the real nodeId of the hub yet)
    this._hubNodeId = `static-hub-${hubAddress}`;

    // Parse host:port from hubAddress
    const colonIdx = hubAddress.lastIndexOf(':');
    const host = colonIdx >= 0 ? hubAddress.substring(0, colonIdx) : hubAddress;
    const port =
      colonIdx >= 0 ? parseInt(hubAddress.substring(colonIdx + 1), 10) : 3000;

    // Create a synthetic peer representing the static hub
    this._syntheticPeer = {
      nodeId: this._hubNodeId,
      hostname: `static-${host}`,
      localIps: [host],
      domain: identity.domain,
      port,
      startedAt: 0, // unknown
    };

    this._active = true;

    this._emit('peer-discovered', this._syntheticPeer);
    this._emit('hub-assigned', this._hubNodeId);

    return true;
  }

  /** Stop the layer */
  async stop(): Promise<void> {
    if (this._active && this._hubNodeId) {
      this._emit('peer-lost', this._hubNodeId);
    }
    this._active = false;
    this._hubAddress = null;
    this._hubNodeId = null;
    this._syntheticPeer = null;
    this._listeners.clear();
  }

  /** Whether this layer is currently active */
  isActive(): boolean {
    return this._active;
  }

  /** Get the synthetic peer for the configured hub (or empty array) */
  getPeers(): NodeInfo[] {
    if (!this._syntheticPeer) return [];
    return [this._syntheticPeer];
  }

  /** Get the statically configured hub nodeId */
  getAssignedHub(): NodeId | null {
    return this._hubNodeId;
  }

  /** Get the raw hub address string ("ip:port") */
  getHubAddress(): string | null {
    return this._hubAddress;
  }

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

  // ...........................................................................

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
