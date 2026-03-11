// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import { connect } from 'node:net';

import type { PeerProbe } from '../types/peer-probe.ts';
import type { NodeId } from '../types/node-info.ts';

// .............................................................................

/** Options for a single probe */
export interface ProbeOptions {
  /** TCP connect timeout in ms (default: 2000) */
  timeoutMs?: number;
}

// .............................................................................

/**
 * Probes a peer's reachability via real TCP connect.
 *
 * Opens a TCP socket to host:port, measures the time until the
 * connection is established (or fails), then closes the socket.
 * This is the same technique used by `tcping` and similar tools.
 * @param host - The peer's IP address or hostname
 * @param port - The peer's port
 * @param fromNodeId - This node's ID (for the probe result)
 * @param toNodeId - The peer's node ID (for the probe result)
 * @param options - Probe options (timeout, etc.)
 * @returns A PeerProbe with reachability and latency
 */
export async function probePeer(
  host: string,
  port: number,
  fromNodeId: NodeId,
  toNodeId: NodeId,
  options?: ProbeOptions,
): Promise<PeerProbe> {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const start = performance.now();

  return new Promise<PeerProbe>((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });

    /**
     * Clean up and resolve
     * @param reachable - Whether the connection was successful
     */
    const finish = (reachable: boolean) => {
      const elapsed = performance.now() - start;
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        fromNodeId,
        toNodeId,
        reachable,
        latencyMs: reachable ? Math.round(elapsed * 100) / 100 : -1,
        measuredAt: Date.now(),
      });
    };

    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
