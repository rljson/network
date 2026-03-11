// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server, type AddressInfo } from 'node:net';

import { NetworkManager } from '../src/network-manager';
import { defaultNetworkConfig } from '../src/types/network-config';
import type { NetworkConfig } from '../src/types/network-config';
import type {
  TopologyChangedEvent,
  RoleChangedEvent,
  HubChangedEvent,
} from '../src/types/network-events';
import type { NodeInfo } from '../src/types/node-info';
import type { ProbeFn } from '../src/probing/probe-scheduler';
import type { PeerProbe } from '../src/types/peer-probe';

// .............................................................................

/** Default config for testing */
function testConfig(overrides?: Partial<NetworkConfig>): NetworkConfig {
  return {
    ...defaultNetworkConfig('test-domain', 3000),
    ...overrides,
  };
}

// .............................................................................

describe('NetworkManager', () => {
  let manager: NetworkManager;

  afterEach(async () => {
    if (manager?.isRunning()) {
      await manager.stop();
    }
  });

  // .........................................................................
  // Lifecycle
  // .........................................................................

  describe('lifecycle', () => {
    it('starts and stops', async () => {
      manager = new NetworkManager(testConfig());
      expect(manager.isRunning()).toBe(false);

      await manager.start();
      expect(manager.isRunning()).toBe(true);

      await manager.stop();
      expect(manager.isRunning()).toBe(false);
    });

    it('start is idempotent', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();
      await manager.start(); // should not throw
      expect(manager.isRunning()).toBe(true);
    });

    it('stop is idempotent', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();
      await manager.stop();
      await manager.stop(); // should not throw
      expect(manager.isRunning()).toBe(false);
    });
  });

  // .........................................................................
  // Identity
  // .........................................................................

  describe('identity', () => {
    it('creates node identity on start', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const identity = manager.getIdentity();
      expect(identity.nodeId).toBeTruthy();
      expect(identity.domain).toBe('test-domain');
    });
  });

  // .........................................................................
  // Topology without static config
  // .........................................................................

  describe('topology without static config', () => {
    it('starts as unassigned when no static hub configured', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const topology = manager.getTopology();
      expect(topology.myRole).toBe('unassigned');
      expect(topology.hubNodeId).toBeNull();
      expect(topology.hubAddress).toBeNull();
      expect(topology.domain).toBe('test-domain');
    });

    it('includes self in topology nodes', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const topology = manager.getTopology();
      const identity = manager.getIdentity();
      expect(topology.nodes.has(identity.nodeId)).toBe(true);
    });

    it('returns empty probes array', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const topology = manager.getTopology();
      expect(topology.probes).toEqual([]);
    });
  });

  // .........................................................................
  // Static layer integration
  // .........................................................................

  describe('static layer', () => {
    it('becomes client when static hub is configured', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '192.168.1.100:3000' },
        }),
      );
      await manager.start();

      const topology = manager.getTopology();
      expect(topology.myRole).toBe('client');
      expect(topology.hubNodeId).toBe('static-hub-192.168.1.100:3000');
      expect(topology.hubAddress).toBe('192.168.1.100:3000');
      expect(topology.formedBy).toBe('static');
    });

    it('includes static hub peer in topology nodes', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '10.0.0.1:4000' },
        }),
      );
      await manager.start();

      const topology = manager.getTopology();
      expect(topology.nodes.has('static-hub-10.0.0.1:4000')).toBe(true);
    });
  });

  // .........................................................................
  // Manual override
  // .........................................................................

  describe('manual override', () => {
    it('manual override supersedes static config', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '192.168.1.100:3000' },
        }),
      );
      await manager.start();

      // Initially static
      expect(manager.getTopology().formedBy).toBe('static');

      // Manual override
      manager.assignHub('custom-hub-node');

      const topology = manager.getTopology();
      expect(topology.formedBy).toBe('manual');
      expect(topology.hubNodeId).toBe('custom-hub-node');
    });

    it('clearing override reverts to static', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '192.168.1.100:3000' },
        }),
      );
      await manager.start();

      manager.assignHub('custom-hub-node');
      expect(manager.getTopology().formedBy).toBe('manual');

      manager.clearOverride();

      const topology = manager.getTopology();
      expect(topology.formedBy).toBe('static');
      expect(topology.hubNodeId).toBe('static-hub-192.168.1.100:3000');
    });

    it('manual override with no static → becomes client for manual hub', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      expect(manager.getTopology().myRole).toBe('unassigned');

      manager.assignHub('some-hub');
      expect(manager.getTopology().myRole).toBe('client');
      expect(manager.getTopology().formedBy).toBe('manual');
    });

    it('assigning self as hub → role becomes hub', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const selfId = manager.getIdentity().nodeId;
      manager.assignHub(selfId);

      expect(manager.getTopology().myRole).toBe('hub');
    });

    it('clearing override with no static → reverts to unassigned', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      manager.assignHub('some-hub');
      expect(manager.getTopology().myRole).toBe('client');

      manager.clearOverride();
      expect(manager.getTopology().myRole).toBe('unassigned');
    });
  });

  // .........................................................................
  // Events
  // .........................................................................

  describe('events', () => {
    it('emits topology-changed on start', async () => {
      manager = new NetworkManager(testConfig());

      const events: TopologyChangedEvent[] = [];
      manager.on('topology-changed', (e) => events.push(e));

      await manager.start();

      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]!.topology.domain).toBe('test-domain');
    });

    it('emits role-changed when role changes', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const roleChanges: RoleChangedEvent[] = [];
      manager.on('role-changed', (e) => roleChanges.push(e));

      manager.assignHub('some-hub');
      expect(roleChanges).toContainEqual({
        previous: 'unassigned',
        current: 'client',
      });
    });

    it('emits hub-changed when hub changes', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const hubChanges: HubChangedEvent[] = [];
      manager.on('hub-changed', (e) => hubChanges.push(e));

      manager.assignHub('hub-a');
      expect(hubChanges).toContainEqual({
        previousHub: null,
        currentHub: 'hub-a',
      });

      // Change hub
      manager.assignHub('hub-b');
      expect(hubChanges).toContainEqual({
        previousHub: 'hub-a',
        currentHub: 'hub-b',
      });
    });

    it('emits peer-joined for static hub peer', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '10.0.0.1:3000' },
        }),
      );

      const joinedPeers: NodeInfo[] = [];
      manager.on('peer-joined', (peer) => joinedPeers.push(peer));

      await manager.start();

      expect(joinedPeers.length).toBe(1);
      expect(joinedPeers[0]!.nodeId).toBe('static-hub-10.0.0.1:3000');
    });

    it('does not emit role-changed when role stays the same', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const roleChanges: RoleChangedEvent[] = [];
      manager.on('role-changed', (e) => roleChanges.push(e));

      // Assign hub twice with same role transition → only fires once
      manager.assignHub('hub-a');
      const countAfterFirst = roleChanges.length;
      manager.assignHub('hub-b'); // still client → no role-changed
      expect(roleChanges.length).toBe(countAfterFirst);
    });

    it('does not emit hub-changed when hub stays the same', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const hubChanges: HubChangedEvent[] = [];
      manager.on('hub-changed', (e) => hubChanges.push(e));

      manager.assignHub('hub-a');
      const countAfterFirst = hubChanges.length;
      manager.assignHub('hub-a'); // same hub → no hub-changed
      expect(hubChanges.length).toBe(countAfterFirst);
    });

    it('off removes a listener', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const events: TopologyChangedEvent[] = [];
      const cb = (e: TopologyChangedEvent) => events.push(e);
      manager.on('topology-changed', cb);

      manager.assignHub('hub-a');
      const countWithListener = events.length;

      manager.off('topology-changed', cb);
      manager.assignHub('hub-b');
      expect(events.length).toBe(countWithListener); // not called again
    });

    it('supports multiple listeners on the same event', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const eventsA: HubChangedEvent[] = [];
      const eventsB: HubChangedEvent[] = [];
      manager.on('hub-changed', (e) => eventsA.push(e));
      manager.on('hub-changed', (e) => eventsB.push(e));

      manager.assignHub('hub-x');
      expect(eventsA.length).toBe(1);
      expect(eventsB.length).toBe(1);
    });
  });

  // .........................................................................
  // Hub address resolution
  // .........................................................................

  describe('hub address resolution', () => {
    it('returns static hubAddress for static hub', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '192.168.1.50:4000' },
        }),
      );
      await manager.start();

      expect(manager.getTopology().hubAddress).toBe('192.168.1.50:4000');
    });

    it('returns null hubAddress when no hub', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      expect(manager.getTopology().hubAddress).toBeNull();
    });

    it('resolves address from peer table for manual hub', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '10.0.0.1:3000' },
        }),
      );
      await manager.start();

      // Override to static-hub peer (which exists in peer table)
      manager.assignHub('static-hub-10.0.0.1:3000');

      // Manual override → address resolved from peer table
      const topology = manager.getTopology();
      expect(topology.formedBy).toBe('manual');
      expect(topology.hubAddress).toBe('10.0.0.1:3000');
    });

    it('returns null when manual hub is unknown peer', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      manager.assignHub('unknown-node');

      const topology = manager.getTopology();
      expect(topology.hubAddress).toBeNull();
    });
  });

  // .........................................................................
  // Probe scheduler integration
  // .........................................................................

  describe('probe scheduler', () => {
    it('starts probe scheduler when probing is enabled', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const scheduler = manager.getProbeScheduler();
      expect(scheduler.isRunning()).toBe(true);
    });

    it('stops probe scheduler on stop()', async () => {
      manager = new NetworkManager(testConfig());
      await manager.start();

      const scheduler = manager.getProbeScheduler();
      expect(scheduler.isRunning()).toBe(true);

      await manager.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('does not start probe scheduler when probing is disabled', async () => {
      manager = new NetworkManager(testConfig({ probing: { enabled: false } }));
      await manager.start();

      const scheduler = manager.getProbeScheduler();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('topology includes probe results', async () => {
      const mockProbe: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: true,
        latencyMs: 1.0,
        measuredAt: Date.now(),
      });

      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '192.168.1.100:3000' },
          probing: { enabled: true, intervalMs: 60000 },
        }),
        { probeFn: mockProbe },
      );
      await manager.start();

      // Manually trigger a probe cycle
      await manager.getProbeScheduler().runOnce();

      const topology = manager.getTopology();
      expect(topology.probes.length).toBeGreaterThan(0);
      expect(topology.probes[0]!.toNodeId).toBe(
        'static-hub-192.168.1.100:3000',
      );
    });

    it('updates peers in probe scheduler when peers change', async () => {
      manager = new NetworkManager(
        testConfig({
          probing: { enabled: true, intervalMs: 60000 },
        }),
        {
          probeFn: async (
            _h,
            _p,
            fromNodeId,
            toNodeId,
          ): Promise<PeerProbe> => ({
            fromNodeId,
            toNodeId,
            reachable: true,
            latencyMs: 1.0,
            measuredAt: Date.now(),
          }),
        },
      );
      await manager.start();

      // No static hub → no peers initially
      const scheduler = manager.getProbeScheduler();
      const probes = await scheduler.runOnce();
      expect(probes).toHaveLength(0);
    });
  });

  // .........................................................................
  // Hub election integration
  // .........................................................................

  describe('hub election via probing', () => {
    it('manual override still supersedes election', async () => {
      const mockProbe: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: true,
        latencyMs: 1.0,
        measuredAt: Date.now(),
      });

      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '10.0.0.1:3000' },
          probing: { enabled: true, intervalMs: 60000 },
        }),
        { probeFn: mockProbe },
      );
      await manager.start();

      // Run probes so election data is available
      await manager.getProbeScheduler().runOnce();

      // Manual override should win over election
      manager.assignHub('manual-hub');
      const topology = manager.getTopology();
      expect(topology.formedBy).toBe('manual');
      expect(topology.hubNodeId).toBe('manual-hub');
    });

    it('election result used when probes are available', async () => {
      const mockProbe: ProbeFn = async (
        _h,
        _p,
        fromNodeId,
        toNodeId,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: true,
        latencyMs: 1.0,
        measuredAt: Date.now(),
      });

      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '10.0.0.1:3000' },
          probing: { enabled: true, intervalMs: 60000 },
        }),
        { probeFn: mockProbe },
      );
      await manager.start();

      // Run probes → election should trigger
      await manager.getProbeScheduler().runOnce();

      const topology = manager.getTopology();
      // With probes available, election should take over
      expect(topology.formedBy).toBe('election');
      expect(topology.hubNodeId).toBeTruthy();
    });

    it('falls back to static when no probes available', async () => {
      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: '10.0.0.1:3000' },
          probing: { enabled: false },
        }),
      );
      await manager.start();

      const topology = manager.getTopology();
      expect(topology.formedBy).toBe('static');
    });
  });

  // .........................................................................
  // Tier 2: Real TCP integration
  // .........................................................................

  describe('Tier 2: Real TCP probing', () => {
    const servers: Array<{ stop: () => Promise<void> }> = [];

    afterEach(async () => {
      for (const s of servers) {
        await s.stop();
      }
      servers.length = 0;
    });

    /** Start a real TCP server on a random port */
    const startTcpServer = (): Promise<{
      port: number;
      server: Server;
      stop: () => Promise<void>;
    }> => {
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
    };

    it('probes real TCP server via NetworkManager', async () => {
      const tcp = await startTcpServer();
      servers.push(tcp);

      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: `127.0.0.1:${tcp.port}` },
          probing: { enabled: true, intervalMs: 60000, timeoutMs: 1000 },
        }),
      );
      await manager.start();

      // Run a real probe cycle
      await manager.getProbeScheduler().runOnce();

      const topology = manager.getTopology();
      expect(topology.probes.length).toBeGreaterThan(0);
      const probe = topology.probes[0]!;
      expect(probe.reachable).toBe(true);
      expect(probe.latencyMs).toBeGreaterThan(0);
    });

    it('detects unreachable static hub via real probe', async () => {
      // Start and immediately stop to get a refused port
      const tcp = await startTcpServer();
      const deadPort = tcp.port;
      await tcp.stop();

      manager = new NetworkManager(
        testConfig({
          static: { hubAddress: `127.0.0.1:${deadPort}` },
          probing: { enabled: true, intervalMs: 60000, timeoutMs: 500 },
        }),
      );
      await manager.start();

      // Run a real probe cycle
      await manager.getProbeScheduler().runOnce();

      const topology = manager.getTopology();
      const probe = topology.probes[0]!;
      expect(probe.reachable).toBe(false);
    });
  });
});
