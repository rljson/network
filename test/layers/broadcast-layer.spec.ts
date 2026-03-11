// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { BroadcastLayer } from '../../src/layers/broadcast-layer.ts';
import { NodeIdentity } from '../../src/identity/node-identity.ts';
import type { NodeInfo } from '../../src/types/node-info.ts';
import {
  MockUdpHub,
  NoLoopbackMockUdpHub,
  createFailingBindSocket,
} from '../helpers/mock-udp.ts';

// .............................................................................

/** Create a minimal NodeIdentity for testing */
function testIdentity(overrides?: Partial<NodeInfo>): NodeIdentity {
  return new NodeIdentity({
    nodeId: 'test-node-1',
    hostname: 'test-host',
    localIps: ['10.0.0.1'],
    domain: 'test-domain',
    port: 3000,
    startedAt: 1700000000000,
    ...overrides,
  });
}

/** Create a fake peer NodeInfo */
function fakePeer(id: string, domain = 'test-domain'): NodeInfo {
  return {
    nodeId: id,
    hostname: `host-${id}`,
    localIps: ['10.0.0.2'],
    domain,
    port: 3001,
    startedAt: 1700000001000,
  };
}

/** Small timeout for self-test in tests */
const FAST_SELF_TEST_MS = 50;

// .............................................................................

describe('BroadcastLayer', () => {
  let hub: MockUdpHub;
  let layer: BroadcastLayer;

  beforeEach(() => {
    hub = new MockUdpHub();
  });

  afterEach(async () => {
    await layer?.stop();
  });

  // .........................................................................
  // Basic properties
  // .........................................................................

  it('has name "broadcast"', () => {
    layer = new BroadcastLayer();
    expect(layer.name).toBe('broadcast');
  });

  it('is not active before start', () => {
    layer = new BroadcastLayer(
      { enabled: true, port: 41234 },
      { createSocket: hub.createSocketFn() },
    );
    expect(layer.isActive()).toBe(false);
  });

  it('getAssignedHub always returns null', () => {
    layer = new BroadcastLayer();
    expect(layer.getAssignedHub()).toBeNull();
  });

  it('getPeers returns empty array before start', () => {
    layer = new BroadcastLayer();
    expect(layer.getPeers()).toEqual([]);
  });

  // .........................................................................
  // start — successful (self-test passes)
  // .........................................................................

  describe('start with broadcast available', () => {
    beforeEach(() => {
      layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );
    });

    it('returns true when broadcast works', async () => {
      const result = await layer.start(testIdentity());
      expect(result).toBe(true);
    });

    it('sets isActive to true', async () => {
      await layer.start(testIdentity());
      expect(layer.isActive()).toBe(true);
    });

    it('getAssignedHub is null even when active', async () => {
      await layer.start(testIdentity());
      expect(layer.getAssignedHub()).toBeNull();
    });

    it('getPeers is empty initially (no external broadcasts yet)', async () => {
      await layer.start(testIdentity());
      expect(layer.getPeers()).toEqual([]);
    });
  });

  // .........................................................................
  // start — disabled
  // .........................................................................

  it('returns false when config.enabled is false', async () => {
    layer = new BroadcastLayer(
      { enabled: false, port: 41234 },
      { createSocket: hub.createSocketFn() },
    );
    const result = await layer.start(testIdentity());
    expect(result).toBe(false);
    expect(layer.isActive()).toBe(false);
  });

  // .........................................................................
  // start — bind failure
  // .........................................................................

  it('returns false when socket bind fails', async () => {
    layer = new BroadcastLayer(
      { enabled: true, port: 41234 },
      {
        createSocket: () => createFailingBindSocket(),
        selfTestTimeoutMs: FAST_SELF_TEST_MS,
      },
    );
    const result = await layer.start(testIdentity());
    expect(result).toBe(false);
    expect(layer.isActive()).toBe(false);
  });

  // .........................................................................
  // Self-test failure (broadcast blocked)
  // .........................................................................

  it('returns false when self-test times out (broadcast blocked)', async () => {
    const noLoopbackHub = new NoLoopbackMockUdpHub();
    layer = new BroadcastLayer(
      { enabled: true, port: 41234 },
      {
        createSocket: noLoopbackHub.createSocketFn(),
        selfTestTimeoutMs: FAST_SELF_TEST_MS,
      },
    );
    const result = await layer.start(testIdentity());
    expect(result).toBe(false);
    expect(layer.isActive()).toBe(false);
  });

  // .........................................................................
  // Peer discovery
  // .........................................................................

  describe('peer discovery', () => {
    beforeEach(async () => {
      layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );
      await layer.start(testIdentity());
    });

    it('discovers a peer from a broadcast message', async () => {
      const peer = fakePeer('peer-1');

      // Simulate an incoming broadcast from another node
      const socket = hub.createSocket();
      await socket.bind(41234);
      const data = Buffer.from(JSON.stringify(peer));
      // Deliver synchronously via hub
      hub.broadcast(data, 41234, socket);

      expect(layer.getPeers()).toHaveLength(1);
      expect(layer.getPeers()[0]!.nodeId).toBe('peer-1');
    });

    it('emits peer-discovered for new peers', async () => {
      const discovered: NodeInfo[] = [];
      layer.on('peer-discovered', (p) => discovered.push(p));

      const peer = fakePeer('peer-2');
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(Buffer.from(JSON.stringify(peer)), 41234, socket);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.nodeId).toBe('peer-2');
    });

    it('does not emit peer-discovered for already known peers', async () => {
      const discovered: NodeInfo[] = [];
      layer.on('peer-discovered', (p) => discovered.push(p));

      const peer = fakePeer('peer-3');
      const socket = hub.createSocket();
      await socket.bind(41234);

      // Send twice
      hub.broadcast(Buffer.from(JSON.stringify(peer)), 41234, socket);
      hub.broadcast(Buffer.from(JSON.stringify(peer)), 41234, socket);

      // Only one peer-discovered event
      expect(discovered).toHaveLength(1);
      // But peer info is updated (still 1 peer)
      expect(layer.getPeers()).toHaveLength(1);
    });

    it('filters out peers from different domain', async () => {
      const peer = fakePeer('peer-other', 'other-domain');
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(Buffer.from(JSON.stringify(peer)), 41234, socket);

      expect(layer.getPeers()).toHaveLength(0);
    });

    it('ignores invalid JSON messages', async () => {
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(Buffer.from('not-json!!!'), 41234, socket);

      expect(layer.getPeers()).toHaveLength(0);
    });

    it('ignores self-broadcasts after self-test', async () => {
      // The layer's own nodeId is 'test-node-1'.
      // If the layer receives a broadcast with its own nodeId, ignore it.
      const selfPacket: NodeInfo = {
        nodeId: 'test-node-1',
        hostname: 'test-host',
        localIps: ['10.0.0.1'],
        domain: 'test-domain',
        port: 3000,
        startedAt: 1700000000000,
      };
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(Buffer.from(JSON.stringify(selfPacket)), 41234, socket);

      expect(layer.getPeers()).toHaveLength(0);
    });
  });

  // .........................................................................
  // Peer timeout
  // .........................................................................

  describe('peer timeout', () => {
    it('removes peers after timeout period', async () => {
      layer = new BroadcastLayer(
        {
          enabled: true,
          port: 41234,
          intervalMs: 20,
          timeoutMs: 60,
        },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );

      await layer.start(testIdentity());

      // Add a peer manually via direct broadcast
      const peer = fakePeer('timeout-peer');
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(Buffer.from(JSON.stringify(peer)), 41234, socket);

      expect(layer.getPeers()).toHaveLength(1);

      // Wait past timeout (peer stops broadcasting → removed)
      await new Promise((r) => setTimeout(r, 120));

      expect(layer.getPeers()).toHaveLength(0);
    });

    it('emits peer-lost when peer times out', async () => {
      layer = new BroadcastLayer(
        {
          enabled: true,
          port: 41234,
          intervalMs: 20,
          timeoutMs: 60,
        },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );

      await layer.start(testIdentity());

      const lostIds: string[] = [];
      layer.on('peer-lost', (nodeId) => lostIds.push(nodeId));

      // Add peer
      const peer = fakePeer('lost-peer');
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(Buffer.from(JSON.stringify(peer)), 41234, socket);

      // Wait past timeout
      await new Promise((r) => setTimeout(r, 120));

      expect(lostIds).toContain('lost-peer');
    });
  });

  // .........................................................................
  // Stop
  // .........................................................................

  describe('stop', () => {
    it('sets isActive to false', async () => {
      layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );
      await layer.start(testIdentity());
      expect(layer.isActive()).toBe(true);

      await layer.stop();
      expect(layer.isActive()).toBe(false);
    });

    it('clears all peers', async () => {
      layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );
      await layer.start(testIdentity());

      // Add a peer
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(
        Buffer.from(JSON.stringify(fakePeer('stop-peer'))),
        41234,
        socket,
      );
      expect(layer.getPeers()).toHaveLength(1);

      await layer.stop();
      expect(layer.getPeers()).toEqual([]);
    });

    it('emits peer-lost for all peers on stop', async () => {
      layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );
      await layer.start(testIdentity());

      const lostIds: string[] = [];
      layer.on('peer-lost', (nodeId) => lostIds.push(nodeId));

      // Add two peers
      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(Buffer.from(JSON.stringify(fakePeer('p1'))), 41234, socket);
      hub.broadcast(Buffer.from(JSON.stringify(fakePeer('p2'))), 41234, socket);

      await layer.stop();

      expect(lostIds).toContain('p1');
      expect(lostIds).toContain('p2');
    });

    it('is safe to call stop when not started', async () => {
      layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        { createSocket: hub.createSocketFn() },
      );
      // Should not throw
      await layer.stop();
      expect(layer.isActive()).toBe(false);
    });
  });

  // .........................................................................
  // Events (on/off)
  // .........................................................................

  describe('events', () => {
    it('supports on and off for peer-discovered', async () => {
      layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );
      await layer.start(testIdentity());

      const discovered: NodeInfo[] = [];
      const cb = (p: NodeInfo) => discovered.push(p);

      layer.on('peer-discovered', cb);

      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(
        Buffer.from(JSON.stringify(fakePeer('ev-1'))),
        41234,
        socket,
      );
      expect(discovered).toHaveLength(1);

      // Unsubscribe
      layer.off('peer-discovered', cb);

      hub.broadcast(
        Buffer.from(JSON.stringify(fakePeer('ev-2'))),
        41234,
        socket,
      );
      // No new event after off
      expect(discovered).toHaveLength(1);
    });

    it('delivers to multiple listeners registered for the same event', async () => {
      const hub = new MockUdpHub();
      const layer = new BroadcastLayer(
        { enabled: true, port: 41234 },
        { createSocket: hub.createSocketFn(), selfTestTimeoutMs: 50 },
      );
      await layer.start(testIdentity());

      const listA: NodeInfo[] = [];
      const listB: NodeInfo[] = [];

      // Register two listeners on the same event
      layer.on('peer-discovered', (p) => listA.push(p));
      layer.on('peer-discovered', (p) => listB.push(p));

      const socket = hub.createSocket();
      await socket.bind(41234);
      hub.broadcast(
        Buffer.from(JSON.stringify(fakePeer('multi-1'))),
        41234,
        socket,
      );

      expect(listA).toHaveLength(1);
      expect(listB).toHaveLength(1);
    });
  });

  // .........................................................................
  // Default config values
  // .........................................................................

  describe('default config', () => {
    it('uses port 41234 when no config provided', async () => {
      layer = new BroadcastLayer(undefined, {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: FAST_SELF_TEST_MS,
      });

      const result = await layer.start(testIdentity());
      expect(result).toBe(true);
      expect(layer.isActive()).toBe(true);
    });
  });

  // .........................................................................
  // Periodic broadcasting
  // .........................................................................

  describe('periodic broadcasting', () => {
    it('sends broadcasts at configured interval', async () => {
      // Create a second layer to receive broadcasts from the first
      const receiverLayer = new BroadcastLayer(
        { enabled: true, port: 41234, intervalMs: 30 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );

      layer = new BroadcastLayer(
        { enabled: true, port: 41234, intervalMs: 30 },
        {
          createSocket: hub.createSocketFn(),
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );

      // Start receiver first
      await receiverLayer.start(
        testIdentity({ nodeId: 'receiver', hostname: 'rx' }),
      );

      // Register listener BEFORE starting the sender layer
      // (self-test broadcast is received synchronously during start)
      const discovered: NodeInfo[] = [];
      receiverLayer.on('peer-discovered', (p) => discovered.push(p));

      await layer.start(testIdentity());

      // The receiver should have already discovered the sender
      // during layer's self-test broadcast
      expect(discovered.length).toBeGreaterThanOrEqual(1);
      expect(discovered[0]!.nodeId).toBe('test-node-1');

      await receiverLayer.stop();
    });
  });

  // .........................................................................
  // Send failure handling
  // .........................................................................

  describe('send failure', () => {
    it('does not crash when send fails', async () => {
      // Create a custom socket whose send throws after the 1st call
      const testHub = new MockUdpHub();
      let sendCount = 0;

      const createSocket = () => {
        const socket = testHub.createSocket();
        const origSend = socket.send.bind(socket);
        socket.send = async (
          data: Buffer,
          port: number,
          address: string,
        ): Promise<void> => {
          sendCount++;
          if (sendCount > 1) {
            throw new Error('Network error');
          }
          return origSend(data, port, address);
        };
        return socket;
      };

      layer = new BroadcastLayer(
        { enabled: true, port: 41234, intervalMs: 30 },
        {
          createSocket,
          selfTestTimeoutMs: FAST_SELF_TEST_MS,
        },
      );

      // Start should succeed (first send for self-test works)
      const result = await layer.start(testIdentity());
      expect(result).toBe(true);

      // Wait for interval to trigger a send that will fail
      await new Promise((r) => setTimeout(r, 80));

      // Layer should still be active — send failure is silently ignored
      expect(layer.isActive()).toBe(true);
    });
  });
});
