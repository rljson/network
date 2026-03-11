// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeId, NodeInfo } from '../types/node-info.ts';
import type { NodeIdentity } from '../identity/node-identity.ts';
import type {
  DiscoveryLayer,
  DiscoveryLayerEventName,
  DiscoveryLayerEvents,
} from './discovery-layer.ts';

// .............................................................................

type Listener = DiscoveryLayerEvents[DiscoveryLayerEventName];

/**
 * Always-present manual override layer.
 *
 * Cannot be disabled. Allows a human (or programmatic caller) to force
 * a specific hub, overriding whatever the automatic cascade decided.
 * Clearing the override returns control to the cascade.
 *
 * ManualLayer does NOT discover peers — it only overrides hub assignment.
 */
export class ManualLayer implements DiscoveryLayer {
  readonly name = 'manual';
  private _active = false;
  private _assignedHub: NodeId | null = null;
  private _listeners = new Map<string, Set<Listener>>();

  /**
   * Start always succeeds — manual layer cannot be disabled.
   * @param _identity - Node identity (unused by manual layer)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async start(_identity: NodeIdentity): Promise<boolean> {
    this._active = true;
    return true;
  }

  /** Stop the layer */
  async stop(): Promise<void> {
    this._active = false;
    this._assignedHub = null;
    this._listeners.clear();
  }

  /** Always active after start */
  isActive(): boolean {
    return this._active;
  }

  /** Manual layer does not discover peers */
  getPeers(): NodeInfo[] {
    return [];
  }

  /** Get the manually assigned hub, or null if no override is set */
  getAssignedHub(): NodeId | null {
    return this._assignedHub;
  }

  /**
   * Force a specific node as the hub.
   * @param nodeId - The nodeId to assign as hub
   */
  assignHub(nodeId: NodeId): void {
    this._assignedHub = nodeId;
    this._emit('hub-assigned', nodeId);
  }

  /** Clear the manual override — returns control to the automatic cascade */
  clearOverride(): void {
    this._assignedHub = null;
    this._emit('hub-assigned', null);
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
    /* v8 ignore if -- @preserve */
    if (!set) return;
    for (const cb of set) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}
