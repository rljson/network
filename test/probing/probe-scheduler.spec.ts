// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createServer, type Server, type AddressInfo } from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';

import { ProbeScheduler } from '../../src/probing/probe-scheduler';
import type { ProbeFn } from '../../src/probing/probe-scheduler';
import type { NodeInfo } from '../../src/types/node-info';
import type { PeerProbe } from '../../src/types/peer-probe';

// .............................................................................

/** Helper: create a NodeInfo with minimal fields */
function makeNode(nodeId: string, port: number, ip = '127.0.0.1'): NodeInfo {
  return {
    nodeId,
    hostname: `host-${nodeId}`,
    localIps: [ip],
    domain: 'test',
    port,
    startedAt: Date.now(),
  };
}

/** Helper: create a mock probe function that returns preset results */
function mockProbeFn(results: Map<string, boolean>): {
  fn: ProbeFn;
  calls: string[];
} {
  const calls: string[] = [];
  const fn: ProbeFn = async (
    _host,
    _port,
    fromNodeId,
    toNodeId,
  ): Promise<PeerProbe> => {
    calls.push(toNodeId);
    const reachable = results.get(toNodeId) ?? false;
    return {
      fromNodeId,
      toNodeId,
      reachable,
      latencyMs: reachable ? 1.0 : -1,
      measuredAt: Date.now(),
    };
  };
  return { fn, calls };
}

/** Helper: start a real TCP server, returns port and stop function */
async function startTcpServer(): Promise<{
  port: number;
  server: Server;
  stop: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const stop = () =>
        new Promise<void>((res) => {
          server.close(() => res());
        });
      resolve({ port, server, stop });
    });
  });
}

// .............................................................................

describe('ProbeScheduler', () => {
  let scheduler: ProbeScheduler;
  const servers: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    if (scheduler?.isRunning()) {
      scheduler.stop();
    }
    for (const s of servers) {
      await s.stop();
    }
    servers.length = 0;
  });

  // .........................................................................
  // Tier 1: Unit tests with mock probe function
  // .........................................................................

  describe('Tier 1: Logic (mock probes)', () => {
    it('starts and stops', () => {
      const { fn } = mockProbeFn(new Map());
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });

      expect(scheduler.isRunning()).toBe(false);
      scheduler.start('self');
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('start is idempotent', () => {
      const { fn } = mockProbeFn(new Map());
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.start('self');
      scheduler.start('self'); // should not throw
      expect(scheduler.isRunning()).toBe(true);
    });

    it('stop is idempotent', () => {
      const { fn } = mockProbeFn(new Map());
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.start('self');
      scheduler.stop();
      scheduler.stop(); // should not throw
      expect(scheduler.isRunning()).toBe(false);
    });

    it('probes all peers via runOnce()', async () => {
      const results = new Map([
        ['peer-a', true],
        ['peer-b', false],
      ]);
      const { fn, calls } = mockProbeFn(results);
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });

      scheduler.setPeers([makeNode('peer-a', 3000), makeNode('peer-b', 3001)]);

      const probes = await scheduler.runOnce();

      expect(probes).toHaveLength(2);
      expect(calls).toContain('peer-a');
      expect(calls).toContain('peer-b');

      const probeA = probes.find((p) => p.toNodeId === 'peer-a');
      const probeB = probes.find((p) => p.toNodeId === 'peer-b');
      expect(probeA?.reachable).toBe(true);
      expect(probeB?.reachable).toBe(false);
    });

    it('excludes self from probe list', async () => {
      const { fn, calls } = mockProbeFn(new Map([['self', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });

      scheduler.setPeers([
        makeNode('self', 3000), // self — should be excluded
        makeNode('peer-a', 3001),
      ]);

      scheduler.start('self');
      await scheduler.runOnce();

      expect(calls).not.toContain('self');
      expect(calls).toContain('peer-a');
    });

    it('stores probes and retrieves them', async () => {
      const results = new Map([['peer-a', true]]);
      const { fn } = mockProbeFn(results);
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });

      scheduler.setPeers([makeNode('peer-a', 3000)]);
      await scheduler.runOnce();

      const allProbes = scheduler.getProbes();
      expect(allProbes).toHaveLength(1);
      expect(allProbes[0]!.toNodeId).toBe('peer-a');

      const single = scheduler.getProbe('peer-a');
      expect(single?.reachable).toBe(true);

      expect(scheduler.getProbe('nonexistent')).toBeUndefined();
    });

    it('emits probes-updated after each cycle', async () => {
      const { fn } = mockProbeFn(new Map([['peer-a', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const updates: PeerProbe[][] = [];
      scheduler.on('probes-updated', (probes) => updates.push(probes));

      await scheduler.runOnce();

      expect(updates).toHaveLength(1);
      expect(updates[0]!).toHaveLength(1);
    });

    it('emits probes-updated with empty array when no peers', async () => {
      const { fn } = mockProbeFn(new Map());
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      // No peers set

      const updates: PeerProbe[][] = [];
      scheduler.on('probes-updated', (probes) => updates.push(probes));

      await scheduler.runOnce();

      expect(updates).toHaveLength(1);
      expect(updates[0]!).toHaveLength(0);
    });

    it('detects peer going unreachable', async () => {
      let peerReachable = true;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: peerReachable,
        latencyMs: peerReachable ? 1.0 : -1,
        measuredAt: Date.now(),
      });
      scheduler = new ProbeScheduler({
        probeFn: fn,
        intervalMs: 60000,
        failThreshold: 1,
      });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const unreachableEvents: string[] = [];
      scheduler.on('peer-unreachable', (nodeId) =>
        unreachableEvents.push(nodeId),
      );

      // First cycle: reachable
      await scheduler.runOnce();
      expect(unreachableEvents).toHaveLength(0);

      // Second cycle: unreachable
      peerReachable = false;
      await scheduler.runOnce();
      expect(unreachableEvents).toEqual(['peer-a']);
    });

    it('detects peer coming back reachable', async () => {
      let peerReachable = false;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: peerReachable,
        latencyMs: peerReachable ? 1.0 : -1,
        measuredAt: Date.now(),
      });
      scheduler = new ProbeScheduler({
        probeFn: fn,
        intervalMs: 60000,
        failThreshold: 1,
      });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const reachableEvents: string[] = [];
      scheduler.on('peer-reachable', (nodeId) => reachableEvents.push(nodeId));

      // First cycle: unreachable
      await scheduler.runOnce();
      expect(reachableEvents).toHaveLength(0);

      // Second cycle: reachable
      peerReachable = true;
      await scheduler.runOnce();
      expect(reachableEvents).toEqual(['peer-a']);
    });

    it('does not emit change event on first probe', async () => {
      const { fn } = mockProbeFn(new Map([['peer-a', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const events: string[] = [];
      scheduler.on('peer-reachable', (id) => events.push(`reachable:${id}`));
      scheduler.on('peer-unreachable', (id) =>
        events.push(`unreachable:${id}`),
      );

      await scheduler.runOnce();

      // First probe — no previous state, so no change event
      expect(events).toHaveLength(0);
    });

    it('does not emit change when state stays the same', async () => {
      const { fn } = mockProbeFn(new Map([['peer-a', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const events: string[] = [];
      scheduler.on('peer-reachable', (id) => events.push(`reachable:${id}`));
      scheduler.on('peer-unreachable', (id) =>
        events.push(`unreachable:${id}`),
      );

      await scheduler.runOnce(); // first: no event
      await scheduler.runOnce(); // second: same state, no event

      expect(events).toHaveLength(0);
    });

    it('stop clears probes and state', async () => {
      const { fn } = mockProbeFn(new Map([['peer-a', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.setPeers([makeNode('peer-a', 3000)]);
      scheduler.start('self');

      await scheduler.runOnce();
      expect(scheduler.getProbes()).toHaveLength(1);

      scheduler.stop();
      expect(scheduler.getProbes()).toHaveLength(0);
    });

    it('off removes a listener', async () => {
      const { fn } = mockProbeFn(new Map([['peer-a', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const updates: PeerProbe[][] = [];
      const cb = (probes: PeerProbe[]) => updates.push(probes);

      scheduler.on('probes-updated', cb);
      await scheduler.runOnce();
      expect(updates).toHaveLength(1);

      scheduler.off('probes-updated', cb);
      await scheduler.runOnce();
      expect(updates).toHaveLength(1); // no new update
    });

    it('supports multiple callbacks on the same event', async () => {
      const { fn } = mockProbeFn(new Map([['peer-a', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const updates1: PeerProbe[][] = [];
      const updates2: PeerProbe[][] = [];

      scheduler.on('probes-updated', (probes) => updates1.push(probes));
      scheduler.on('probes-updated', (probes) => updates2.push(probes));

      await scheduler.runOnce();
      expect(updates1).toHaveLength(1);
      expect(updates2).toHaveLength(1);
    });

    it('uses default ip when localIps is empty', async () => {
      const { fn, calls } = mockProbeFn(new Map([['peer-a', true]]));
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });

      const peer = makeNode('peer-a', 3000);
      peer.localIps = []; // empty
      scheduler.setPeers([peer]);

      await scheduler.runOnce();
      expect(calls).toContain('peer-a');
    });

    it('runs on interval when started', async () => {
      let callCount = 0;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => {
        callCount++;
        return {
          fromNodeId,
          toNodeId,
          reachable: true,
          latencyMs: 1.0,
          measuredAt: Date.now(),
        };
      };
      scheduler = new ProbeScheduler({
        probeFn: fn,
        intervalMs: 100, // fast interval for test
      });
      scheduler.setPeers([makeNode('peer-a', 3000)]);
      scheduler.start('self');

      // Wait for a few cycles
      await new Promise((resolve) => setTimeout(resolve, 350));

      scheduler.stop();

      // Should have run at least 3 cycles (immediate + 2 intervals)
      expect(callCount).toBeGreaterThanOrEqual(3);
    });
  });

  // .........................................................................
  // Flap dampening tests
  // .........................................................................

  describe('Flap dampening', () => {
    it('does not emit peer-unreachable until failThreshold is reached', async () => {
      let peerReachable = true;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: peerReachable,
        latencyMs: peerReachable ? 1.0 : -1,
        measuredAt: Date.now(),
      });
      scheduler = new ProbeScheduler({
        probeFn: fn,
        intervalMs: 60000,
        failThreshold: 3,
      });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const unreachable: string[] = [];
      scheduler.on('peer-unreachable', (id) => unreachable.push(id));

      // Cycle 1: reachable → establishes baseline
      await scheduler.runOnce();
      expect(unreachable).toHaveLength(0);

      // Cycle 2: first failure → no event (1 < 3)
      peerReachable = false;
      await scheduler.runOnce();
      expect(unreachable).toHaveLength(0);

      // Cycle 3: second failure → no event (2 < 3)
      await scheduler.runOnce();
      expect(unreachable).toHaveLength(0);

      // Cycle 4: third failure → event fires (3 >= 3)
      await scheduler.runOnce();
      expect(unreachable).toEqual(['peer-a']);
    });

    it('resets fail counter on single success', async () => {
      let peerReachable = true;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: peerReachable,
        latencyMs: peerReachable ? 1.0 : -1,
        measuredAt: Date.now(),
      });
      scheduler = new ProbeScheduler({
        probeFn: fn,
        intervalMs: 60000,
        failThreshold: 3,
      });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const unreachable: string[] = [];
      scheduler.on('peer-unreachable', (id) => unreachable.push(id));

      // Establish baseline
      await scheduler.runOnce();

      // 2 failures (below threshold)
      peerReachable = false;
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect(unreachable).toHaveLength(0);

      // 1 success → resets counter
      peerReachable = true;
      await scheduler.runOnce();

      // 2 more failures → still below threshold (counter was reset)
      peerReachable = false;
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect(unreachable).toHaveLength(0);
    });

    it('emits peer-reachable immediately on first success after threshold', async () => {
      let peerReachable = true;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: peerReachable,
        latencyMs: peerReachable ? 1.0 : -1,
        measuredAt: Date.now(),
      });
      scheduler = new ProbeScheduler({
        probeFn: fn,
        intervalMs: 60000,
        failThreshold: 2,
      });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const reachable: string[] = [];
      const unreachable: string[] = [];
      scheduler.on('peer-reachable', (id) => reachable.push(id));
      scheduler.on('peer-unreachable', (id) => unreachable.push(id));

      // Establish reachable baseline
      await scheduler.runOnce();

      // Hit threshold: 2 failures → unreachable
      peerReachable = false;
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect(unreachable).toEqual(['peer-a']);

      // Single success → immediately reachable (no dampening for recovery)
      peerReachable = true;
      await scheduler.runOnce();
      expect(reachable).toEqual(['peer-a']);
    });

    it('uses default failThreshold of 3', async () => {
      let peerReachable = true;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: peerReachable,
        latencyMs: peerReachable ? 1.0 : -1,
        measuredAt: Date.now(),
      });
      // No failThreshold → default 3
      scheduler = new ProbeScheduler({ probeFn: fn, intervalMs: 60000 });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const unreachable: string[] = [];
      scheduler.on('peer-unreachable', (id) => unreachable.push(id));

      // Baseline
      await scheduler.runOnce();

      // 2 failures → not yet
      peerReachable = false;
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect(unreachable).toHaveLength(0);

      // 3rd failure → fires
      await scheduler.runOnce();
      expect(unreachable).toEqual(['peer-a']);
    });

    it('does not re-emit unreachable once already declared', async () => {
      let peerReachable = true;
      const fn: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: peerReachable,
        latencyMs: peerReachable ? 1.0 : -1,
        measuredAt: Date.now(),
      });
      scheduler = new ProbeScheduler({
        probeFn: fn,
        intervalMs: 60000,
        failThreshold: 1,
      });
      scheduler.setPeers([makeNode('peer-a', 3000)]);

      const unreachable: string[] = [];
      scheduler.on('peer-unreachable', (id) => unreachable.push(id));

      // Baseline reachable
      await scheduler.runOnce();

      // First failure → unreachable (threshold=1)
      peerReachable = false;
      await scheduler.runOnce();
      expect(unreachable).toEqual(['peer-a']);

      // More failures → no duplicate event
      await scheduler.runOnce();
      await scheduler.runOnce();
      expect(unreachable).toEqual(['peer-a']);
    });
  });

  // .........................................................................
  // Tier 2: Integration tests with real TCP
  // .........................................................................

  describe('Tier 2: Real TCP (localhost)', () => {
    it('probes a real TCP server successfully', async () => {
      const tcp = await startTcpServer();
      servers.push(tcp);

      scheduler = new ProbeScheduler({ timeoutMs: 1000 });
      scheduler.setPeers([makeNode('real-peer', tcp.port)]);

      const probes = await scheduler.runOnce();

      expect(probes).toHaveLength(1);
      expect(probes[0]!.reachable).toBe(true);
      expect(probes[0]!.latencyMs).toBeGreaterThan(0);
      expect(probes[0]!.toNodeId).toBe('real-peer');
    });

    it('detects real connection refused', async () => {
      const tcp = await startTcpServer();
      const closedPort = tcp.port;
      await tcp.stop(); // close the server → port refused

      scheduler = new ProbeScheduler({ timeoutMs: 500 });
      scheduler.setPeers([makeNode('dead-peer', closedPort)]);

      const probes = await scheduler.runOnce();

      expect(probes).toHaveLength(1);
      expect(probes[0]!.reachable).toBe(false);
      expect(probes[0]!.latencyMs).toBe(-1);
    });

    it('real probe cycle with mixed live/dead peers', async () => {
      const tcp1 = await startTcpServer();
      const tcp2 = await startTcpServer();
      servers.push(tcp1);
      const deadPort = tcp2.port;
      await tcp2.stop(); // kill second server

      scheduler = new ProbeScheduler({ timeoutMs: 500 });
      scheduler.setPeers([
        makeNode('alive-peer', tcp1.port),
        makeNode('dead-peer', deadPort),
      ]);

      const probes = await scheduler.runOnce();

      const alive = probes.find((p) => p.toNodeId === 'alive-peer');
      const dead = probes.find((p) => p.toNodeId === 'dead-peer');
      expect(alive?.reachable).toBe(true);
      expect(dead?.reachable).toBe(false);
    });

    it('detects real server going down between cycles', async () => {
      const tcp = await startTcpServer();
      servers.push(tcp);

      scheduler = new ProbeScheduler({ timeoutMs: 500, failThreshold: 1 });
      scheduler.setPeers([makeNode('flaky-peer', tcp.port)]);

      const events: string[] = [];
      scheduler.on('peer-unreachable', (id) => events.push(id));

      // Cycle 1: server is up
      const probes1 = await scheduler.runOnce();
      expect(probes1[0]!.reachable).toBe(true);
      expect(events).toHaveLength(0);

      // Kill the server
      await tcp.stop();
      // Remove from servers cleanup list since already stopped
      servers.length = 0;

      // Cycle 2: server is down
      const probes2 = await scheduler.runOnce();
      expect(probes2[0]!.reachable).toBe(false);
      expect(events).toEqual(['flaky-peer']);
    });

    it('detects real server coming back up between cycles', async () => {
      // Start and immediately stop to get a port
      const tcp1 = await startTcpServer();
      const port = tcp1.port;
      await tcp1.stop();

      scheduler = new ProbeScheduler({ timeoutMs: 500 });
      scheduler.setPeers([makeNode('revived-peer', port)]);

      const events: string[] = [];
      scheduler.on('peer-reachable', (id) => events.push(id));

      // Cycle 1: server is down
      const probes1 = await scheduler.runOnce();
      expect(probes1[0]!.reachable).toBe(false);

      // Start a new server on the same port
      const tcp2 = await new Promise<{
        server: Server;
        stop: () => Promise<void>;
      }>((resolve) => {
        const server = createServer();
        server.listen(port, '127.0.0.1', () => {
          const stop = () =>
            new Promise<void>((res) => {
              server.close(() => res());
            });
          resolve({ server, stop });
        });
      });
      servers.push(tcp2);

      // Cycle 2: server is back up
      const probes2 = await scheduler.runOnce();
      expect(probes2[0]!.reachable).toBe(true);
      expect(events).toEqual(['revived-peer']);
    });

    it('multiple real peers probed in parallel', async () => {
      const tcp1 = await startTcpServer();
      const tcp2 = await startTcpServer();
      const tcp3 = await startTcpServer();
      servers.push(tcp1, tcp2, tcp3);

      scheduler = new ProbeScheduler({ timeoutMs: 1000 });
      scheduler.setPeers([
        makeNode('peer-1', tcp1.port),
        makeNode('peer-2', tcp2.port),
        makeNode('peer-3', tcp3.port),
      ]);

      const probes = await scheduler.runOnce();

      expect(probes).toHaveLength(3);
      for (const probe of probes) {
        expect(probe.reachable).toBe(true);
      }
    });
  });
});
