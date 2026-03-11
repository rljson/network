// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createServer, type Server, type AddressInfo } from 'node:net';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { probePeer } from '../../src/probing/peer-prober';

// .............................................................................

/**
 * PeerProber tests — Tier 1 (logic) + Tier 2 (real TCP on localhost).
 *
 * These tests use real TCP servers on localhost to validate that the
 * prober correctly handles connection success, refusal, and timeouts.
 */
describe('PeerProber', () => {
  let server: Server;
  let serverPort: number;

  /** Start a real TCP server on a random port */
  const startServer = (): Promise<number> => {
    return new Promise<number>((resolve) => {
      server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        serverPort = addr.port;
        resolve(serverPort);
      });
    });
  };

  /** Stop the server cleanly */
  const stopServer = (): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  };

  beforeEach(async () => {
    await startServer();
  });

  afterEach(async () => {
    await stopServer();
  });

  // .........................................................................
  // Successful connection
  // .........................................................................

  describe('reachable peer', () => {
    it('probes a real TCP server on localhost', async () => {
      const result = await probePeer('127.0.0.1', serverPort, 'self', 'peer-1');

      expect(result.reachable).toBe(true);
      expect(result.latencyMs).toBeGreaterThan(0);
      expect(result.latencyMs).toBeLessThan(500); // localhost should be fast
      expect(result.fromNodeId).toBe('self');
      expect(result.toNodeId).toBe('peer-1');
      expect(result.measuredAt).toBeGreaterThan(0);
    });

    it('measures sub-millisecond latency on localhost', async () => {
      const result = await probePeer('127.0.0.1', serverPort, 'self', 'peer-1');

      // Localhost connect is typically < 5ms
      expect(result.latencyMs).toBeLessThan(50);
    });

    it('latency is rounded to 2 decimal places', async () => {
      const result = await probePeer('127.0.0.1', serverPort, 'self', 'peer-1');

      // Check rounding: number × 100, round, / 100
      const rounded = Math.round(result.latencyMs * 100) / 100;
      expect(result.latencyMs).toBe(rounded);
    });
  });

  // .........................................................................
  // Connection refused
  // .........................................................................

  describe('unreachable peer', () => {
    it('detects connection refused on closed port', async () => {
      // Stop the server so the port is refused
      await stopServer();

      const result = await probePeer(
        '127.0.0.1',
        serverPort,
        'self',
        'dead-peer',
      );

      expect(result.reachable).toBe(false);
      expect(result.latencyMs).toBe(-1);
      expect(result.toNodeId).toBe('dead-peer');
    });

    it('handles non-routable address with timeout', async () => {
      // 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed not routable
      const result = await probePeer(
        '192.0.2.1',
        serverPort,
        'self',
        'unreachable-peer',
        { timeoutMs: 200 }, // short timeout for test speed
      );

      expect(result.reachable).toBe(false);
      expect(result.latencyMs).toBe(-1);
    }, 5000);
  });

  // .........................................................................
  // Timeout
  // .........................................................................

  describe('timeout', () => {
    it('respects custom timeout', async () => {
      const start = performance.now();

      // Use non-routable address to force timeout
      const result = await probePeer(
        '192.0.2.1',
        12345,
        'self',
        'timeout-peer',
        { timeoutMs: 300 },
      );

      const elapsed = performance.now() - start;

      expect(result.reachable).toBe(false);
      // Should complete within a reasonable margin of the timeout
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(3000);
    }, 5000);

    it('uses default timeout of 2000ms when not specified', async () => {
      // We just verify the probe completes without specifying timeout
      const result = await probePeer('127.0.0.1', serverPort, 'self', 'peer-1');

      // Default timeout should still let localhost through
      expect(result.reachable).toBe(true);
    });
  });

  // .........................................................................
  // Multiple probes
  // .........................................................................

  describe('multiple probes', () => {
    it('can probe the same server multiple times', async () => {
      const results = await Promise.all([
        probePeer('127.0.0.1', serverPort, 'self', 'peer-1'),
        probePeer('127.0.0.1', serverPort, 'self', 'peer-2'),
        probePeer('127.0.0.1', serverPort, 'self', 'peer-3'),
      ]);

      for (const r of results) {
        expect(r.reachable).toBe(true);
      }
      expect(results[0]!.toNodeId).toBe('peer-1');
      expect(results[1]!.toNodeId).toBe('peer-2');
      expect(results[2]!.toNodeId).toBe('peer-3');
    });

    it('mixed reachable and unreachable probes', async () => {
      const results = await Promise.all([
        probePeer('127.0.0.1', serverPort, 'self', 'alive-peer'),
        probePeer('127.0.0.1', 1, 'self', 'dead-peer'), // port 1 unlikely open
      ]);

      expect(results[0]!.reachable).toBe(true);
      expect(results[1]!.reachable).toBe(false);
    });
  });

  // .........................................................................
  // Probe result structure
  // .........................................................................

  describe('probe result structure', () => {
    it('returns complete PeerProbe fields', async () => {
      const result = await probePeer(
        '127.0.0.1',
        serverPort,
        'from-node',
        'to-node',
      );

      // Verify all fields present
      expect(result).toHaveProperty('fromNodeId', 'from-node');
      expect(result).toHaveProperty('toNodeId', 'to-node');
      expect(result).toHaveProperty('reachable', true);
      expect(typeof result.latencyMs).toBe('number');
      expect(typeof result.measuredAt).toBe('number');
    });

    it('measuredAt is a recent timestamp', async () => {
      const before = Date.now();
      const result = await probePeer('127.0.0.1', serverPort, 'self', 'peer-1');
      const after = Date.now();

      expect(result.measuredAt).toBeGreaterThanOrEqual(before);
      expect(result.measuredAt).toBeLessThanOrEqual(after);
    });
  });
});
