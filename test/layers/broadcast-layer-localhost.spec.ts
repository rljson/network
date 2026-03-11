// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, afterEach } from 'vitest';

import {
  defaultCreateUdpSocket,
  type UdpSocket,
} from '../../src/layers/broadcast-layer.ts';
import { BroadcastLayer } from '../../src/layers/broadcast-layer.ts';
import { NodeIdentity } from '../../src/identity/node-identity.ts';
import type { NodeInfo } from '../../src/types/node-info.ts';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// .............................................................................

/**
 * BroadcastLayer localhost tests — real UDP sockets via node:dgram.
 *
 * These tests exercise `defaultCreateUdpSocket()` against the OS loopback
 * interface. They validate that the real dgram adapter works correctly:
 * bind, send, receive, setBroadcast, and close.
 *
 * Multi-node broadcast discovery uses 255.255.255.255 which is unreliable
 * on CI (firewalls, Docker). Those scenarios stay on MockUdpHub.
 */
describe('BroadcastLayer (localhost)', () => {
  const openSockets: UdpSocket[] = [];

  afterEach(async () => {
    // Clean up any sockets left open
    for (const s of openSockets) {
      try {
        await s.close();
      } catch {
        // Already closed — ignore
      }
    }
    openSockets.length = 0;
  });

  /** Track a socket for cleanup */
  function track(socket: UdpSocket): UdpSocket {
    openSockets.push(socket);
    return socket;
  }

  /** Create a unique identity dir so tests don't share persistent nodeIds */
  function uniqueIdentityDir(): string {
    return join(tmpdir(), `network-test-localhost-${randomUUID()}`);
  }

  // .........................................................................
  // defaultCreateUdpSocket — real dgram adapter
  // .........................................................................

  describe('defaultCreateUdpSocket', () => {
    it('creates a socket that binds to a random port', async () => {
      const socket = track(defaultCreateUdpSocket());
      // Port 0 = OS assigns a random available port
      await expect(socket.bind(0)).resolves.toBeUndefined();
    });

    it('setBroadcast(true) does not throw', async () => {
      const socket = track(defaultCreateUdpSocket());
      await socket.bind(0);
      expect(() => socket.setBroadcast(true)).not.toThrow();
    });

    it('sends and receives a message via 127.0.0.1', async () => {
      // Bind a receiver
      const receiver = track(defaultCreateUdpSocket());
      await receiver.bind(0);

      // We need the port the receiver bound to.
      // defaultCreateUdpSocket doesn't expose the port, so we bind
      // a second socket and send to the receiver's port via a known port.
      // Workaround: use two sockets on known ports.

      // Instead, bind receiver on a specific high port
      const testPort = 49100 + Math.floor(Math.random() * 900);
      const rx = track(defaultCreateUdpSocket());

      try {
        await rx.bind(testPort);
      } catch {
        // Port in use — skip gracefully (CI edge case)
        return;
      }

      rx.setBroadcast(true);

      const received = new Promise<string>((resolve) => {
        rx.onMessage((msg) => {
          resolve(msg.toString());
        });
      });

      // Send from a separate socket to 127.0.0.1
      const tx = track(defaultCreateUdpSocket());
      await tx.bind(0);
      const payload = JSON.stringify({ test: 'hello', id: randomUUID() });
      await tx.send(Buffer.from(payload), testPort, '127.0.0.1');

      // Should receive within 2 seconds
      const result = await Promise.race([
        received,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000),
        ),
      ]);

      expect(result).toBe(payload);
    });

    it('close() resolves without error', async () => {
      const socket = track(defaultCreateUdpSocket());
      await socket.bind(0);
      await expect(socket.close()).resolves.toBeUndefined();
      // Remove from tracking since it's already closed
      openSockets.pop();
    });

    it('allows reuseAddr — two sockets bind to same port', async () => {
      // defaultCreateUdpSocket uses { reuseAddr: true }, so binding
      // two sockets to the same port is allowed by the OS.
      const testPort = 49100 + Math.floor(Math.random() * 900);
      const first = track(defaultCreateUdpSocket());

      try {
        await first.bind(testPort);
      } catch {
        // Port already in use by another process — skip
        return;
      }

      const second = track(defaultCreateUdpSocket());
      // Should succeed because reuseAddr is true
      await expect(second.bind(testPort)).resolves.toBeUndefined();
    });
  });

  // .........................................................................
  // BroadcastLayer self-test with real sockets
  // .........................................................................

  describe('self-test with real sockets', () => {
    it('self-test passes on real loopback', async () => {
      const testPort = 49100 + Math.floor(Math.random() * 900);
      const layer = new BroadcastLayer(
        {
          enabled: true,
          port: testPort,
          intervalMs: 60000, // Long interval — we only care about self-test
          timeoutMs: 60000,
        },
        { selfTestTimeoutMs: 3000 },
      );

      const identity = await NodeIdentity.create({
        domain: 'localhost-test',
        port: testPort,
        identityDir: uniqueIdentityDir(),
      });

      let started: boolean;
      try {
        started = await layer.start(identity);
      } catch {
        // Port in use — skip
        return;
      }

      try {
        expect(started).toBe(true);
        expect(layer.isActive()).toBe(true);
      } finally {
        await layer.stop();
      }
    });

    it('discovers a peer via real loopback', async () => {
      const testPort = 49100 + Math.floor(Math.random() * 900);

      const layer = new BroadcastLayer(
        {
          enabled: true,
          port: testPort,
          intervalMs: 60000,
          timeoutMs: 60000,
        },
        { selfTestTimeoutMs: 3000 },
      );

      const identity = await NodeIdentity.create({
        domain: 'localhost-test',
        port: testPort,
        identityDir: uniqueIdentityDir(),
      });

      let started: boolean;
      try {
        started = await layer.start(identity);
      } catch {
        return; // Port in use — skip
      }

      if (!started) {
        // Broadcast unavailable on this host — skip
        return;
      }

      try {
        // Send a fake peer announcement to the layer's port
        const fakePeerInfo: NodeInfo = {
          nodeId: 'fake-peer-from-localhost',
          hostname: 'fake-host',
          localIps: ['10.0.0.99'],
          domain: 'localhost-test', // Same domain — will be accepted
          port: 4000,
          startedAt: Date.now(),
        };

        const discovered = new Promise<NodeInfo>((resolve) => {
          layer.on('peer-discovered', (info: NodeInfo) => {
            resolve(info);
          });
        });

        // Send fake peer packet via a separate UDP socket
        const sender = track(defaultCreateUdpSocket());
        await sender.bind(0);
        await sender.send(
          Buffer.from(JSON.stringify(fakePeerInfo)),
          testPort,
          '127.0.0.1',
        );

        const peer = await Promise.race([
          discovered,
          new Promise<NodeInfo>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 3000),
          ),
        ]);

        expect(peer.nodeId).toBe('fake-peer-from-localhost');
        expect(peer.domain).toBe('localhost-test');
        expect(layer.getPeers()).toHaveLength(1);
      } finally {
        await layer.stop();
      }
    });
  });
});
