// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import {
  createServer as defaultCreateServer,
  type Server,
  type AddressInfo,
} from 'node:net';

// .............................................................................

/** Injectable dependencies for ProbeListener (testing) */
export interface ProbeListenerDeps {
  /** Factory for the TCP server (defaults to node:net.createServer) */
  createServer: typeof defaultCreateServer;
}

/** Default deps using real node:net.createServer */
export function defaultProbeListenerDeps(): ProbeListenerDeps {
  return { createServer: defaultCreateServer };
}

// .............................................................................

/**
 * Lightweight TCP server that accepts and immediately closes any
 * incoming connection.
 *
 * Its sole purpose is to provide a reliable target for peer probing:
 * other nodes complete a TCP handshake against this port so they can
 * measure round-trip latency without needing any application-level
 * protocol.
 *
 * Bind to port `0` to let the OS assign an ephemeral port — the
 * actual bound port is returned from {@link start} and should be
 * propagated into the node's NodeInfo so peers know where to probe.
 */
export class ProbeListener {
  private readonly _createServer: typeof defaultCreateServer;
  private _server: Server | null = null;
  private _port: number | null = null;

  constructor(deps?: ProbeListenerDeps) {
    const d = deps ?? defaultProbeListenerDeps();
    this._createServer = d.createServer;
  }

  /**
   * Start listening on the given port.
   * @param port - TCP port; pass `0` to receive an ephemeral port
   * @returns The actual bound port (useful when `port === 0`)
   */
  start(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = this._createServer((socket) => {
        // Immediately close the connection — the TCP handshake itself
        // is the latency measurement.
        socket.end();
      });

      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        reject(err);
      };

      const onListening = (): void => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo;
        this._server = server;
        this._port = addr.port;
        resolve(addr.port);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
  }

  /** Stop the server (no-op if not started) */
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      const server = this._server;
      if (!server) {
        resolve();
        return;
      }
      this._server = null;
      this._port = null;
      server.close(() => resolve());
    });
  }

  /** Whether the listener is currently bound */
  isRunning(): boolean {
    return this._server !== null;
  }

  /** The actual bound port, or null when not running */
  getPort(): number | null {
    return this._port;
  }
}
