// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/* eslint-disable @typescript-eslint/no-unused-vars */

// .............................................................................

import type {
  UdpSocket,
  RemoteInfo,
  CreateUdpSocket,
} from '../../src/layers/broadcast-layer.ts';

// .............................................................................

/**
 * In-memory UDP broadcast hub for testing.
 *
 * Connects multiple MockUdpSocket instances and simulates broadcast
 * delivery. All sockets bound to the same port receive each broadcast,
 * including the sender (simulating OS loopback).
 */
export class MockUdpHub {
  protected _sockets: MockUdpSocket[] = [];

  /** Create a new mock socket connected to this hub */
  createSocket(): MockUdpSocket {
    const socket = new MockUdpSocket(this);
    this._sockets.push(socket);
    return socket;
  }

  /** Factory function compatible with CreateUdpSocket */
  createSocketFn(): CreateUdpSocket {
    return () => this.createSocket();
  }

  /**
   * Deliver a broadcast message to all sockets bound to the given port.
   * Includes the sender (loopback), simulating real UDP broadcast.
   * Delivery is synchronous for test determinism.
   * @param msg - The message buffer
   * @param port - The target UDP port
   * @param sender - The sending socket
   */
  broadcast(msg: Buffer, port: number, sender: MockUdpSocket): void {
    for (const socket of this._sockets) {
      if (socket.boundPort === port && !socket.isClosed) {
        socket.receive(msg, {
          address: sender.address,
          port: sender.boundPort ?? 0,
        });
      }
    }
  }

  /**
   * Remove a socket from the hub (on close).
   * @param socket - The socket to remove
   */
  removeSocket(socket: MockUdpSocket): void {
    const idx = this._sockets.indexOf(socket);
    if (idx >= 0) this._sockets.splice(idx, 1);
  }
}

// .............................................................................

/**
 * In-memory mock UDP socket for testing.
 *
 * Supports bind, send (via MockUdpHub broadcast), message handling,
 * and close. All operations are synchronous for test determinism.
 */
export class MockUdpSocket implements UdpSocket {
  /** The port this socket is bound to */
  boundPort: number | null = null;

  /** The simulated local address */
  address = '127.0.0.1';

  /** Whether this socket has been closed */
  isClosed = false;

  private _messageHandler: ((msg: Buffer, rinfo: RemoteInfo) => void) | null =
    null;

  /**
   * Create a MockUdpSocket.
   * @param _hub - The MockUdpHub for broadcast delivery
   */
  constructor(private readonly _hub: MockUdpHub) {}

  /** Bind the socket to a port */
  async bind(port: number): Promise<void> {
    this.boundPort = port;
  }

  /**
   * Send data via the mock hub.
   * Delivery is synchronous for test determinism.
   * @param data - The data to send
   * @param port - Target port
   * @param _address - Target address (ignored — hub handles routing)
   */
  async send(data: Buffer, port: number, _address: string): Promise<void> {
    if (this.isClosed) return;
    this._hub.broadcast(data, port, this);
  }

  /**
   * Register a message handler.
   * @param handler - The callback for received messages
   */
  onMessage(handler: (msg: Buffer, rinfo: RemoteInfo) => void): void {
    this._messageHandler = handler;
  }

  /** Enable broadcasting (no-op in mock) */
  setBroadcast(_flag: boolean): void {
    // No-op in mock
  }

  /** Close the socket and remove from hub */
  async close(): Promise<void> {
    this.isClosed = true;
    this._hub.removeSocket(this);
  }

  /**
   * Simulate receiving a message (called by MockUdpHub).
   * @param msg - The received message buffer
   * @param rinfo - Remote info
   */
  receive(msg: Buffer, rinfo: RemoteInfo): void {
    if (this._messageHandler && !this.isClosed) {
      this._messageHandler(msg, rinfo);
    }
  }
}

// .............................................................................

/**
 * Mock UDP hub that does NOT deliver to the sender (no loopback).
 * Used to simulate networks where broadcast is blocked.
 */
export class NoLoopbackMockUdpHub extends MockUdpHub {
  override broadcast(msg: Buffer, port: number, sender: MockUdpSocket): void {
    // Deliver to all sockets EXCEPT the sender — simulating blocked loopback
    for (const socket of this._sockets) {
      if (socket.boundPort === port && !socket.isClosed && socket !== sender) {
        socket.receive(msg, {
          address: sender.address,
          port: sender.boundPort ?? 0,
        });
      }
    }
  }
}

// .............................................................................

/**
 * Mock socket factory that always fails on bind.
 * Used to test the "bind failure" code path.
 */
export function createFailingBindSocket(): UdpSocket {
  return {
    async bind(_port: number): Promise<void> {
      throw new Error('Port in use');
    },
    async send(_data: Buffer, _port: number, _address: string): Promise<void> {
      // No-op
    },
    onMessage(_handler: (msg: Buffer, rinfo: RemoteInfo) => void): void {
      // No-op
    },
    setBroadcast(_flag: boolean): void {
      // No-op
    },
    async close(): Promise<void> {
      // No-op
    },
  };
}
