// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/* v8 ignore file -- @preserve */

// .............................................................................

import type { NodeId, NodeInfo } from '../types/node-info.ts';
import type { NodeIdentity } from '../identity/node-identity.ts';

// .............................................................................

/** Events emitted by a DiscoveryLayer */
export interface DiscoveryLayerEvents {
  /** A new peer was discovered */
  'peer-discovered': (peer: NodeInfo) => void;
  /** A previously known peer is no longer reachable */
  'peer-lost': (nodeId: string) => void;
  /** This layer is assigning/dictating a specific hub */
  'hub-assigned': (nodeId: string | null) => void;
}

/** Valid event names for DiscoveryLayer */
export type DiscoveryLayerEventName = keyof DiscoveryLayerEvents;

// .............................................................................

/**
 * Contract for all discovery mechanisms.
 *
 * Each layer decides HOW to discover peers. The NetworkManager tries layers
 * in cascade order and uses the most autonomous one that produces a result.
 */
export interface DiscoveryLayer {
  /** Layer name: 'broadcast' | 'cloud' | 'static' | 'manual' */
  readonly name: string;

  /**
   * Start the layer. Returns false if this layer is not available
   * (e.g., no config, no network interface, etc.).
   * @param identity - This node's identity
   */
  start(identity: NodeIdentity): Promise<boolean>;

  /** Stop the layer and clean up resources */
  stop(): Promise<void>;

  /** Whether this layer is currently active */
  isActive(): boolean;

  /** Get all currently known peers from this layer */
  getPeers(): NodeInfo[];

  /**
   * Get the hub this layer has assigned/dictated.
   * Some layers (static, cloud, manual) dictate the hub.
   * Others (broadcast) return null — hub is elected, not assigned.
   */
  getAssignedHub(): NodeId | null;

  /** Subscribe to layer events */
  on<E extends DiscoveryLayerEventName>(
    event: E,
    cb: DiscoveryLayerEvents[E],
  ): void;

  /** Unsubscribe from layer events */
  off<E extends DiscoveryLayerEventName>(
    event: E,
    cb: DiscoveryLayerEvents[E],
  ): void;
}
