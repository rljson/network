// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';

import { NetworkManager } from '../../src/network-manager.ts';
import type { NetworkConfig } from '../../src/types/network-config.ts';
import type { PeerProbe } from '../../src/types/peer-probe.ts';
import { MockUdpHub } from '../helpers/mock-udp.ts';

// .............................................................................

/** Create a unique temp directory for identity persistence */
function uniqueIdentityDir(): string {
  return join(tmpdir(), 'rljson-network-test-' + randomUUID());
}

/** Create a manager config with broadcast enabled via mock UDP */
function broadcastConfig(port: number, domain = 'e2e-test'): NetworkConfig {
  return {
    domain,
    port,
    identityDir: uniqueIdentityDir(),
    broadcast: {
      enabled: true,
      port: 55555, // Mock UDP port (won't conflict with real ports)
      intervalMs: 50,
      timeoutMs: 200,
    },
    probing: { enabled: true, intervalMs: 50, timeoutMs: 100 },
  };
}

/**
 * Create a mock probe function that reports all known peers as reachable.
 * @param reachablePeers - Set of nodeIds that are reachable
 */
function mockProbeFn(
  reachablePeers: Set<string>,
): (
  host: string,
  port: number,
  fromNodeId: string,
  toNodeId: string,
) => Promise<PeerProbe> {
  return async (
    _host: string,
    _port: number,
    fromNodeId: string,
    toNodeId: string,
  ): Promise<PeerProbe> => ({
    fromNodeId,
    toNodeId,
    reachable: reachablePeers.has(toNodeId),
    latencyMs: reachablePeers.has(toNodeId) ? 1 : -1,
    timestamp: Date.now(),
  });
}

// .............................................................................

describe('E2E: Broadcast Path', () => {
  const managers: NetworkManager[] = [];

  afterEach(async () => {
    for (const m of managers) {
      await m.stop();
    }
    managers.length = 0;
  });

  // .........................................................................

  it('two nodes discover each other via broadcast and elect hub', async () => {
    const hub = new MockUdpHub();
    const reachable = new Set<string>();

    // Node A — started earlier → should become hub
    const configA = broadcastConfig(3000);
    const managerA = new NetworkManager(configA, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(managerA);

    // Node B — started later
    const configB = broadcastConfig(3001);
    const managerB = new NetworkManager(configB, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(managerB);

    // Start both nodes
    await managerA.start();
    await managerB.start();

    // Wait for broadcast intervals to discover each other
    await new Promise((r) => setTimeout(r, 150));

    // Both should have discovered each other
    const topoA = managerA.getTopology();
    const topoB = managerB.getTopology();

    // Both topologies should have 2 nodes (self + peer)
    const nodeCountA = Object.keys(topoA.nodes).length;
    const nodeCountB = Object.keys(topoB.nodes).length;
    expect(nodeCountA).toBeGreaterThanOrEqual(2);
    expect(nodeCountB).toBeGreaterThanOrEqual(2);

    // With broadcast active, formedBy should include 'broadcast' once
    // probes happen. Let's make peers reachable.
    const idA = managerA.getIdentity().nodeId;
    const idB = managerB.getIdentity().nodeId;
    reachable.add(idA);
    reachable.add(idB);

    // Wait for probes to run
    await new Promise((r) => setTimeout(r, 150));

    const updatedTopoA = managerA.getTopology();
    expect(updatedTopoA.hubNodeId).toBeTruthy();
    expect(updatedTopoA.formedBy).toBe('broadcast');
  });

  // .........................................................................

  it('hub re-election occurs when hub becomes unreachable', async () => {
    const hub = new MockUdpHub();
    const reachable = new Set<string>();

    const configA = broadcastConfig(3000);
    const managerA = new NetworkManager(configA, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(managerA);

    const configB = broadcastConfig(3001);
    const managerB = new NetworkManager(configB, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(managerB);

    await managerA.start();
    await managerB.start();

    const idA = managerA.getIdentity().nodeId;
    const idB = managerB.getIdentity().nodeId;

    // Both reachable initially
    reachable.add(idA);
    reachable.add(idB);

    // Wait for discovery + probes
    await new Promise((r) => setTimeout(r, 200));

    const topo1 = managerA.getTopology();
    expect(topo1.hubNodeId).toBeTruthy();
    const firstHub = topo1.hubNodeId!;

    // Make first hub unreachable
    reachable.delete(firstHub);

    // Wait for probes to detect unreachability
    await new Promise((r) => setTimeout(r, 200));

    // The remaining node should become the new hub
    const survivingManager = firstHub === idA ? managerB : managerA;
    const survivingId = firstHub === idA ? idB : idA;
    const topo2 = survivingManager.getTopology();

    // The surviving node should now be the hub
    expect(topo2.hubNodeId).toBe(survivingId);
  });

  // .........................................................................

  it('nodes in different domains do not discover each other', async () => {
    const hub = new MockUdpHub();
    const reachable = new Set<string>();

    const configA = broadcastConfig(3000, 'domain-alpha');
    const managerA = new NetworkManager(configA, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(managerA);

    const configB = broadcastConfig(3001, 'domain-beta');
    const managerB = new NetworkManager(configB, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(managerB);

    await managerA.start();
    await managerB.start();

    // Wait for broadcast intervals
    await new Promise((r) => setTimeout(r, 150));

    // Each should only see itself — no peers from the other domain
    const topoA = managerA.getTopology();
    const topoB = managerB.getTopology();

    expect(Object.keys(topoA.nodes)).toHaveLength(1); // just self
    expect(Object.keys(topoB.nodes)).toHaveLength(1); // just self
  });
});
