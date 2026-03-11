// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeId, NodeInfo } from './types/node-info.ts';
import type { DiscoveryLayer } from './layers/discovery-layer.ts';

// .............................................................................

/** Events emitted by PeerTable */
export interface PeerTableEvents {
  'peer-joined': (peer: NodeInfo) => void;
  'peer-left': (nodeId: string) => void;
}

type PeerTableEventName = keyof PeerTableEvents;
type PeerTableListener = PeerTableEvents[PeerTableEventName];

// .............................................................................

/**
 * Merged view of all peers from all discovery layers.
 *
 * Deduplicates by nodeId — a peer known by multiple layers appears once.
 * Emits `peer-joined`/`peer-left` when the merged set changes.
 */
export class PeerTable {
  /** All known peers, keyed by nodeId */
  private _peers = new Map<NodeId, NodeInfo>();

  /** Per-layer peer sets, for deduplication tracking */
  private _layerPeers = new Map<string, Set<NodeId>>();

  /** Event listeners */
  private _listeners = new Map<string, Set<PeerTableListener>>();

  /** Self nodeId — excluded from the peer table */
  private _selfId: NodeId | null = null;

  /**
   * Set the self nodeId so it's excluded from the peer table.
   * @param nodeId - This node's own ID
   */
  setSelfId(nodeId: NodeId): void {
    this._selfId = nodeId;
  }

  /**
   * Attach a discovery layer — subscribes to its peer events.
   * Also imports any peers the layer already knows about.
   * @param layer - The discovery layer to attach
   */
  attachLayer(layer: DiscoveryLayer): void {
    const layerName = layer.name;
    if (!this._layerPeers.has(layerName)) {
      this._layerPeers.set(layerName, new Set());
    }

    // Import existing peers from the layer
    for (const peer of layer.getPeers()) {
      this._addPeerFromLayer(layerName, peer);
    }

    // Subscribe to future events
    layer.on('peer-discovered', (peer: NodeInfo) => {
      this._addPeerFromLayer(layerName, peer);
    });

    layer.on('peer-lost', (nodeId: string) => {
      this._removePeerFromLayer(layerName, nodeId);
    });
  }

  /** Get all known peers as an array */
  getPeers(): NodeInfo[] {
    return [...this._peers.values()];
  }

  /**
   * Get a specific peer by nodeId.
   * @param nodeId - The peer's nodeId
   */
  getPeer(nodeId: NodeId): NodeInfo | undefined {
    return this._peers.get(nodeId);
  }

  /** Get the number of known peers */
  get size(): number {
    return this._peers.size;
  }

  /** Clear all peers and layer tracking */
  clear(): void {
    this._peers.clear();
    this._layerPeers.clear();
    this._listeners.clear();
  }

  /**
   * Subscribe to peer table events.
   * @param event - Event name
   * @param cb - Callback
   */
  on<E extends PeerTableEventName>(event: E, cb: PeerTableEvents[E]): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb as PeerTableListener);
  }

  /**
   * Unsubscribe from peer table events.
   * @param event - Event name
   * @param cb - Callback
   */
  off<E extends PeerTableEventName>(event: E, cb: PeerTableEvents[E]): void {
    const set = this._listeners.get(event);
    /* v8 ignore if -- @preserve */
    if (!set) return;
    set.delete(cb as PeerTableListener);
  }

  // ...........................................................................

  /**
   * Add a peer from a specific layer.
   * Only emits peer-joined if this is a genuinely new peer.
   * @param layerName - Name of the source layer
   * @param peer - The peer to add
   */
  private _addPeerFromLayer(layerName: string, peer: NodeInfo): void {
    // Don't add self to peer table
    if (this._selfId && peer.nodeId === this._selfId) return;

    const layerSet = this._layerPeers.get(layerName)!;
    layerSet.add(peer.nodeId);

    const isNew = !this._peers.has(peer.nodeId);
    this._peers.set(peer.nodeId, peer); // update with latest info

    if (isNew) {
      this._emit('peer-joined', peer);
    }
  }

  /**
   * Remove a peer from a specific layer.
   * Only emits peer-left if no other layer still knows about this peer.
   * @param layerName - Name of the source layer
   * @param nodeId - The peer's nodeId
   */
  private _removePeerFromLayer(layerName: string, nodeId: NodeId): void {
    const layerSet = this._layerPeers.get(layerName);
    /* v8 ignore else -- @preserve */
    if (layerSet) {
      layerSet.delete(nodeId);
    }

    // Check if any other layer still knows about this peer
    for (const [name, set] of this._layerPeers) {
      if (name !== layerName && set.has(nodeId)) {
        return; // still known by another layer
      }
    }

    // No layer knows about this peer anymore
    const peer = this._peers.get(nodeId);
    if (peer) {
      this._peers.delete(nodeId);
      this._emit('peer-left', nodeId);
    }
  }

  /**
   * Emit a typed event.
   * @param event - Event name
   * @param args - Event arguments
   */
  private _emit<E extends PeerTableEventName>(
    event: E,
    ...args: Parameters<PeerTableEvents[E]>
  ): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}
