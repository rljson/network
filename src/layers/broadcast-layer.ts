// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import {
  createSocket as dgramCreateSocket,
  type Socket as DgramSocket,
} from 'node:dgram';

import type { NodeId, NodeInfo } from '../types/node-info.ts';
import type { BroadcastConfig } from '../types/network-config.ts';
import type { NodeIdentity } from '../identity/node-identity.ts';
import type {
  DiscoveryLayer,
  DiscoveryLayerEventName,
  DiscoveryLayerEvents,
} from './discovery-layer.ts';

// .............................................................................

/** Remote info about a received UDP packet */
export interface RemoteInfo {
  address: string;
  port: number;
}

/** Abstraction over a UDP socket for testability */
export interface UdpSocket {
  /** Bind the socket to a port */
  bind(port: number): Promise<void>;
  /** Send data via UDP to a target port and address */
  send(data: Buffer, port: number, address: string): Promise<void>;
  /** Register a message handler */
  onMessage(handler: (msg: Buffer, rinfo: RemoteInfo) => void): void;
  /** Enable broadcasting on this socket */
  setBroadcast(flag: boolean): void;
  /** Close the socket */
  close(): Promise<void>;
}

/** Factory function to create a UDP socket */
export type CreateUdpSocket = () => UdpSocket;

// .............................................................................

/**
 * Create a real UDP socket using node:dgram.
 * @returns A UdpSocket backed by a real dgram socket
 */
export function defaultCreateUdpSocket(): UdpSocket {
  const raw: DgramSocket = dgramCreateSocket({ type: 'udp4', reuseAddr: true });

  return {
    bind(port: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        raw.once('error', reject);
        raw.bind(port, () => {
          raw.removeListener('error', reject);
          resolve();
        });
      });
    },

    send(data: Buffer, port: number, address: string): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        raw.send(data, 0, data.length, port, address, (err) => {
          /* v8 ignore if -- @preserve */
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },

    onMessage(handler: (msg: Buffer, rinfo: RemoteInfo) => void): void {
      raw.on('message', handler);
    },

    setBroadcast(flag: boolean): void {
      raw.setBroadcast(flag);
    },

    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        raw.close(resolve);
      });
    },
  };
}

// .............................................................................

/** Injectable dependencies for BroadcastLayer (testing) */
export interface BroadcastLayerDeps {
  /** Custom socket factory — defaults to real dgram */
  createSocket?: CreateUdpSocket;
  /** Self-test timeout in ms — defaults to 2000 */
  selfTestTimeoutMs?: number;
}

type Listener = DiscoveryLayerEvents[DiscoveryLayerEventName];

// .............................................................................

/**
 * UDP broadcast discovery layer — primary automatic discovery (Try 1).
 *
 * Periodically broadcasts this node's info as a JSON packet on a configurable
 * UDP port. Listens for other nodes' broadcasts and maintains a peer table
 * with timeout-based cleanup.
 *
 * On startup, performs a self-test by sending a broadcast and checking for
 * loopback reception. If broadcast is blocked on the network, start() returns
 * false and the NetworkManager falls through to the next layer.
 *
 * BroadcastLayer does NOT assign a hub — it only discovers peers.
 * Hub election is handled by the NetworkManager via the election algorithm.
 */
export class BroadcastLayer implements DiscoveryLayer {
  readonly name = 'broadcast';

  private _active = false;
  private _socket: UdpSocket | null = null;
  private _identity: NodeIdentity | null = null;
  private _broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private _timeoutTimer: ReturnType<typeof setInterval> | null = null;
  private _selfTestCallback: (() => void) | null = null;
  private _peers = new Map<NodeId, { info: NodeInfo; lastSeen: number }>();
  private _listeners = new Map<string, Set<Listener>>();
  private readonly _createSocket: CreateUdpSocket;
  private readonly _selfTestTimeoutMs: number;

  /**
   * Create a BroadcastLayer.
   * @param _config - Broadcast configuration (port, interval, timeout)
   * @param deps - Injectable dependencies for testing
   */
  constructor(
    private readonly _config?: BroadcastConfig,
    deps?: BroadcastLayerDeps,
  ) {
    this._createSocket = deps?.createSocket ?? defaultCreateUdpSocket;
    this._selfTestTimeoutMs = deps?.selfTestTimeoutMs ?? 2000;
  }

  // .........................................................................
  // Lifecycle
  // .........................................................................

  /**
   * Start the broadcast layer.
   *
   * 1. Bind UDP socket to configured port
   * 2. Set up message handler
   * 3. Perform self-test (send broadcast, listen for loopback)
   * 4. If self-test passes: start periodic broadcasting + timeout checker
   * @param identity - This node's identity
   * @returns true if broadcast is available, false otherwise
   */
  async start(identity: NodeIdentity): Promise<boolean> {
    if (this._config?.enabled === false) {
      return false;
    }

    this._identity = identity;
    const port = this._config?.port ?? 41234;

    // Create and bind socket
    this._socket = this._createSocket();

    try {
      await this._socket.bind(port);
    } catch {
      await this._socket.close();
      this._socket = null;
      return false;
    }

    this._socket.setBroadcast(true);

    // Set up message handler BEFORE self-test
    this._socket.onMessage((msg: Buffer, rinfo: RemoteInfo) => {
      this._handleMessage(msg, rinfo);
    });

    // Self-test: send a broadcast and check for loopback reception
    const selfTestPassed = await this._selfTest(port);
    if (!selfTestPassed) {
      await this._socket.close();
      this._socket = null;
      return false;
    }

    this._active = true;

    // Start periodic broadcasting
    const intervalMs = this._config?.intervalMs ?? 5000;
    this._broadcastTimer = setInterval(() => {
      void this._sendBroadcast(port);
    }, intervalMs);

    // Start peer timeout checker
    const timeoutMs = this._config?.timeoutMs ?? 15000;
    this._timeoutTimer = setInterval(() => {
      this._checkTimeouts(timeoutMs);
    }, intervalMs);

    return true;
  }

  /** Stop the layer and clean up resources */
  async stop(): Promise<void> {
    if (this._broadcastTimer) {
      clearInterval(this._broadcastTimer);
      this._broadcastTimer = null;
    }
    if (this._timeoutTimer) {
      clearInterval(this._timeoutTimer);
      this._timeoutTimer = null;
    }

    // Emit peer-lost for all known peers before cleanup
    if (this._active) {
      for (const [nodeId] of this._peers) {
        this._emit('peer-lost', nodeId);
      }
    }

    if (this._socket) {
      await this._socket.close();
      this._socket = null;
    }

    this._peers.clear();
    this._active = false;
    this._identity = null;
    this._selfTestCallback = null;
    this._listeners.clear();
  }

  /** Whether this layer is currently active */
  isActive(): boolean {
    return this._active;
  }

  // .........................................................................
  // Peer access
  // .........................................................................

  /** Get all currently known peers from broadcast discovery */
  getPeers(): NodeInfo[] {
    return [...this._peers.values()].map((e) => e.info);
  }

  /**
   * Broadcast does NOT assign a hub — hub is elected by NetworkManager.
   * Always returns null.
   */
  getAssignedHub(): NodeId | null {
    return null;
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
   * Self-test: send a broadcast and listen for loopback reception.
   * @param port - The UDP port to broadcast on
   * @returns true if own packet was received, false on timeout
   */
  private _selfTest(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let resolved = false;

      this._selfTestCallback = () => {
        /* v8 ignore if -- @preserve */
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      };

      // Send a broadcast packet
      void this._sendBroadcast(port);

      // Timeout — broadcast is blocked on this network
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this._selfTestCallback = null;
          resolve(false);
        }
      }, this._selfTestTimeoutMs);
    });
  }

  /**
   * Send a broadcast packet containing this node's info.
   * @param port - The UDP port to broadcast on
   */
  private async _sendBroadcast(port: number): Promise<void> {
    /* v8 ignore if -- @preserve */
    if (!this._socket || !this._identity) return;

    const info = this._identity.toNodeInfo();
    const data = Buffer.from(JSON.stringify(info));

    try {
      await this._socket.send(data, port, '255.255.255.255');
    } catch {
      // Send failed — network issue, ignore silently
    }
  }

  /**
   * Handle an incoming broadcast message.
   * @param msg - Raw UDP message
   * @param _rinfo - Remote address info (unused — we use packet content)
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _handleMessage(msg: Buffer, _rinfo: RemoteInfo): void {
    let packet: NodeInfo;
    try {
      packet = JSON.parse(msg.toString()) as NodeInfo;
    } catch {
      return; // Invalid JSON — ignore
    }

    // Domain check — only accept peers in same domain
    if (packet.domain !== this._identity?.domain) {
      return;
    }

    // Self-packet detection
    if (packet.nodeId === this._identity?.nodeId) {
      // During self-test, this confirms broadcast is working
      if (this._selfTestCallback) {
        this._selfTestCallback();
        this._selfTestCallback = null;
      }
      return; // Never add self to peer table
    }

    // Add or update peer
    const isNew = !this._peers.has(packet.nodeId);
    this._peers.set(packet.nodeId, { info: packet, lastSeen: Date.now() });

    if (isNew) {
      this._emit('peer-discovered', packet);
    }
  }

  /**
   * Check for timed-out peers and remove them.
   * @param timeoutMs - Maximum silence period before declaring peer lost
   */
  private _checkTimeouts(timeoutMs: number): void {
    const now = Date.now();
    for (const [nodeId, entry] of this._peers) {
      if (now - entry.lastSeen > timeoutMs) {
        this._peers.delete(nodeId);
        this._emit('peer-lost', nodeId);
      }
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
