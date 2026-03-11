// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeId, NodeInfo } from '../types/node-info.ts';
import type { PeerProbe } from '../types/peer-probe.ts';
import { probePeer, type ProbeOptions } from './peer-prober.ts';

// .............................................................................

/** Function signature for probing a single peer */
export type ProbeFn = (
  host: string,
  port: number,
  fromNodeId: NodeId,
  toNodeId: NodeId,
  options?: ProbeOptions,
) => Promise<PeerProbe>;

/** Events emitted by ProbeScheduler */
export interface ProbeSchedulerEvents {
  /** Emitted after a full probe cycle completes */
  'probes-updated': (probes: PeerProbe[]) => void;
  /** Emitted when a peer becomes unreachable */
  'peer-unreachable': (nodeId: NodeId, probe: PeerProbe) => void;
  /** Emitted when a peer becomes reachable (again) */
  'peer-reachable': (nodeId: NodeId, probe: PeerProbe) => void;
}

/** Valid event names for ProbeScheduler */
export type ProbeSchedulerEventName = keyof ProbeSchedulerEvents;

type Listener = ProbeSchedulerEvents[ProbeSchedulerEventName];

/** Options for ProbeScheduler constructor */
export interface ProbeSchedulerOptions {
  /** Interval between probe cycles in ms (default: 10000) */
  intervalMs?: number;
  /** Timeout per individual probe in ms (default: 2000) */
  timeoutMs?: number;
  /** Custom probe function — real TCP by default */
  probeFn?: ProbeFn;
  /**
   * Number of consecutive probe failures before declaring a peer
   * unreachable (default: 3). Prevents flapping on transient failures.
   * A single success resets the counter immediately.
   */
  failThreshold?: number;
}

// .............................................................................

/**
 * Periodically probes all known peers for reachability.
 *
 * Uses real TCP connect probes by default, but accepts an injectable
 * probe function for unit testing.
 *
 * Emits events when probe results change (peer went down / came back up).
 */
export class ProbeScheduler {
  private _intervalMs: number;
  private _timeoutMs: number;
  private _failThreshold: number;
  private _selfId: NodeId = '';
  private _running = false;
  private _timer: ReturnType<typeof setInterval> | null = null;

  /** Latest probe results, keyed by toNodeId */
  private _probes = new Map<NodeId, PeerProbe>();

  /** Previous reachability state, for change detection */
  private _wasReachable = new Map<NodeId, boolean>();

  /** Consecutive failure count per peer, for flap dampening */
  private _failCount = new Map<NodeId, number>();

  /** Event listeners */
  private _listeners = new Map<string, Set<Listener>>();

  /** The probe function — real TCP by default, injectable for tests */
  private readonly _probeFn: ProbeFn;

  /** Peers to probe — updated externally via setPeers() */
  private _peers: NodeInfo[] = [];

  /**
   * Create a ProbeScheduler.
   * @param options - Configuration options
   */
  constructor(options?: ProbeSchedulerOptions) {
    this._intervalMs = options?.intervalMs ?? 10000;
    this._timeoutMs = options?.timeoutMs ?? 2000;
    this._probeFn = options?.probeFn ?? probePeer;
    this._failThreshold = options?.failThreshold ?? 3;
  }

  /**
   * Start the scheduler.
   * @param selfId - This node's ID (excluded from probing)
   */
  start(selfId: NodeId): void {
    if (this._running) return;
    this._selfId = selfId;
    this._running = true;

    // Run first cycle immediately
    void this._runCycle();

    // Schedule subsequent cycles
    this._timer = setInterval(() => {
      void this._runCycle();
    }, this._intervalMs);
  }

  /** Stop the scheduler and clear state */
  stop(): void {
    if (!this._running) return;
    this._running = false;

    /* v8 ignore if -- @preserve */
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this._probes.clear();
    this._wasReachable.clear();
    this._failCount.clear();
    this._peers = [];
  }

  /** Whether the scheduler is currently running */
  isRunning(): boolean {
    return this._running;
  }

  /**
   * Update the list of peers to probe.
   * Call this when the peer table changes.
   * Self is automatically excluded at probe time.
   * @param peers - The current peer list
   */
  setPeers(peers: NodeInfo[]): void {
    this._peers = [...peers];
  }

  /** Get all latest probe results */
  getProbes(): PeerProbe[] {
    return [...this._probes.values()];
  }

  /**
   * Get the latest probe result for a specific peer.
   * @param nodeId - The peer's nodeId
   */
  getProbe(nodeId: NodeId): PeerProbe | undefined {
    return this._probes.get(nodeId);
  }

  /**
   * Run a single probe cycle manually.
   * Useful for tests that need immediate results without waiting.
   */
  async runOnce(): Promise<PeerProbe[]> {
    return this._runCycle();
  }

  // .........................................................................
  // Events
  // .........................................................................

  /**
   * Subscribe to scheduler events.
   * @param event - Event name
   * @param cb - Callback
   */
  on<E extends ProbeSchedulerEventName>(
    event: E,
    cb: ProbeSchedulerEvents[E],
  ): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb as Listener);
  }

  /**
   * Unsubscribe from scheduler events.
   * @param event - Event name
   * @param cb - Callback
   */
  off<E extends ProbeSchedulerEventName>(
    event: E,
    cb: ProbeSchedulerEvents[E],
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
   * Run one probe cycle: probe all peers in parallel.
   */
  private async _runCycle(): Promise<PeerProbe[]> {
    // Filter self at probe time (not at setPeers time)
    const peers = this._peers.filter((p) => p.nodeId !== this._selfId);

    if (peers.length === 0) {
      const empty: PeerProbe[] = [];
      this._emit('probes-updated', empty);
      return empty;
    }

    // Probe all peers in parallel
    const results = await Promise.all(
      peers.map((peer) => {
        const host = peer.localIps[0] ?? '127.0.0.1';
        return this._probeFn(host, peer.port, this._selfId, peer.nodeId, {
          timeoutMs: this._timeoutMs,
        });
      }),
    );

    // Process results and detect changes (with flap dampening)
    for (const probe of results) {
      const previous = this._wasReachable.get(probe.toNodeId);
      this._probes.set(probe.toNodeId, probe);

      if (probe.reachable) {
        // Success: reset fail counter, immediately mark reachable
        this._failCount.set(probe.toNodeId, 0);
        this._wasReachable.set(probe.toNodeId, true);

        if (previous !== undefined && !previous) {
          this._emit('peer-reachable', probe.toNodeId, probe);
        }
      } else {
        // Failure: increment counter, only mark unreachable after threshold
        const count = (this._failCount.get(probe.toNodeId) ?? 0) + 1;
        this._failCount.set(probe.toNodeId, count);

        if (count >= this._failThreshold) {
          this._wasReachable.set(probe.toNodeId, false);

          if (previous !== undefined && previous) {
            this._emit('peer-unreachable', probe.toNodeId, probe);
          }
          /* v8 ignore else -- @preserve */
        } else if (previous === undefined) {
          // First probe for this peer — establish initial state as failing
          this._wasReachable.set(probe.toNodeId, false);
        }
        // Below threshold with known state: keep _wasReachable unchanged
      }
    }

    this._emit('probes-updated', results);
    return results;
  }

  /**
   * Emit a typed event.
   * @param event - Event name
   * @param args - Event arguments
   */
  private _emit<E extends ProbeSchedulerEventName>(
    event: E,
    ...args: Parameters<ProbeSchedulerEvents[E]>
  ): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}
