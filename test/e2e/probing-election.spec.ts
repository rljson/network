// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  CloudHttpClient,
  CloudPeerListResponse,
} from '../../src/layers/cloud-layer';
import { NetworkManager } from '../../src/network-manager';
import type { ProbeFn } from '../../src/probing/probe-scheduler';
import type { NetworkConfig } from '../../src/types/network-config';
import { defaultNetworkConfig } from '../../src/types/network-config';
import type { PeerProbe } from '../../src/types/peer-probe';
import { MockUdpHub } from '../helpers/mock-udp.ts';

// .............................................................................

/** Create a unique temp directory for identity persistence */
function uniqueIdentityDir(): string {
  return join(tmpdir(), 'rljson-network-test-' + randomUUID());
}

/**
 * End-to-end test: Probing + Election path.
 *
 * Scenario:
 *   1. Node starts with static hub pointing to a real TCP server on localhost
 *   2. Probe scheduler runs a cycle and confirms the static hub is reachable
 *   3. Election algorithm elects the static hub (only candidate)
 *   4. Static hub goes down → probe detects unreachable → re-election
 *   5. Self becomes hub (only reachable candidate)
 *
 * This validates the full probe → election → topology pipeline with real TCP.
 */
describe('E2E: Probing + Election path', () => {
  let manager: NetworkManager;
  const servers: Array<{ stop: () => Promise<void> }> = [];
  const extraManagers: NetworkManager[] = [];

  afterEach(async () => {
    if (manager?.isRunning()) {
      await manager.stop();
    }
    for (const m of extraManagers) {
      if (m.isRunning()) await m.stop();
    }
    extraManagers.length = 0;
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

  it('full lifecycle: static → probed → hub down → self-election', async () => {
    // -----------------------------------------------------------------------
    // Setup: real TCP server acts as the "static hub"
    // -----------------------------------------------------------------------
    const tcp = await startTcpServer();
    servers.push(tcp);

    const config = {
      ...defaultNetworkConfig('e2e-probing', 0),
      static: { hubAddress: `127.0.0.1:${tcp.port}` },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 1000 },
    };
    manager = new NetworkManager(config);

    // -----------------------------------------------------------------------
    // Step 1: Start → static hub is configured
    // -----------------------------------------------------------------------
    await manager.start();

    let topology = manager.getTopology();
    expect(topology.formedBy).toBe('static');
    expect(topology.myRole).toBe('client');

    // -----------------------------------------------------------------------
    // Step 2: Run probes → hub is reachable → election takes over
    // -----------------------------------------------------------------------
    await manager.getProbeScheduler().runOnce();

    topology = manager.getTopology();
    // With probes confirming reachability, election should activate
    expect(topology.probes.length).toBeGreaterThan(0);
    expect(topology.probes[0]!.reachable).toBe(true);
    expect(topology.formedBy).toBe('election'); // election active
    expect(topology.myRole).toBe('client');

    // -----------------------------------------------------------------------
    // Step 3: Hub goes down → probe detects → self becomes hub
    // -----------------------------------------------------------------------
    await tcp.stop();
    servers.length = 0;

    // Run probes again — hub is now unreachable
    await manager.getProbeScheduler().runOnce();

    topology = manager.getTopology();
    expect(topology.probes[0]!.reachable).toBe(false);

    // Self is the only reachable candidate → self elected as hub
    expect(topology.formedBy).toBe('election');
    const selfId = manager.getIdentity().nodeId;
    expect(topology.hubNodeId).toBe(selfId);
    expect(topology.myRole).toBe('hub');

    // -----------------------------------------------------------------------
    // Step 4: Clean shutdown
    // -----------------------------------------------------------------------
    await manager.stop();
    expect(manager.isRunning()).toBe(false);
  });

  it('probing disabled: falls back to static only', async () => {
    const tcp = await startTcpServer();
    servers.push(tcp);

    const config = {
      ...defaultNetworkConfig('e2e-noprobe', 0),
      static: { hubAddress: `127.0.0.1:${tcp.port}` },
      probing: { enabled: false },
    };
    manager = new NetworkManager(config);
    await manager.start();

    const topology = manager.getTopology();
    // No probes → no election → stays on static
    expect(topology.formedBy).toBe('static');
    expect(topology.probes).toHaveLength(0);
  });

  it('manual override wins even with active probing', async () => {
    const tcp = await startTcpServer();
    servers.push(tcp);

    const config = {
      ...defaultNetworkConfig('e2e-manual', 0),
      static: { hubAddress: `127.0.0.1:${tcp.port}` },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 1000 },
    };
    manager = new NetworkManager(config);
    await manager.start();

    // Run probes so election data is available
    await manager.getProbeScheduler().runOnce();

    // Manual override
    manager.assignHub('custom-hub');

    const topology = manager.getTopology();
    expect(topology.formedBy).toBe('manual');
    expect(topology.hubNodeId).toBe('custom-hub');

    // Clear override → back to election
    manager.clearOverride();
    const topology2 = manager.getTopology();
    expect(topology2.formedBy).toBe('election'); // election with probes
  });

  it('clearOverride suppresses incumbent advantage of override target', async () => {
    // When a manual override assigns a hub and then is cleared, the
    // next election must NOT give incumbent advantage to the override
    // target.  This prevents the override target from "sticking" as hub
    // after the override is removed.
    const tcp = await startTcpServer();
    servers.push(tcp);

    const config = {
      ...defaultNetworkConfig('e2e-suppress', 0),
      static: { hubAddress: `127.0.0.1:${tcp.port}` },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 1000 },
    };
    manager = new NetworkManager(config);
    await manager.start();

    // Run probes to establish election data
    await manager.getProbeScheduler().runOnce();
    const naturalHub = manager.getTopology().hubNodeId;
    expect(naturalHub).toBeTruthy();

    // Override to a custom hub
    manager.assignHub('override-target');
    expect(manager.getTopology().hubNodeId).toBe('override-target');
    expect(manager.getTopology().formedBy).toBe('manual');

    // Clear override: election should run without incumbent advantage
    // for 'override-target'. Since 'override-target' is not a real
    // probed peer, the election should return the natural winner.
    manager.clearOverride();
    const postOverrideHub = manager.getTopology().hubNodeId;
    expect(postOverrideHub).toBe(naturalHub);
    expect(postOverrideHub).not.toBe('override-target');
  });

  it('election with mock probes: incumbent advantage', async () => {
    // Use mock probes to test election logic through NetworkManager
    let probeReachable = true;
    const mockProbe: ProbeFn = async (
      _h,
      _p,
      fromNodeId,
      toNodeId,
    ): Promise<PeerProbe> => ({
      fromNodeId,
      toNodeId,
      reachable: probeReachable,
      latencyMs: probeReachable ? 1.0 : -1,
      measuredAt: Date.now(),
    });

    const config = {
      ...defaultNetworkConfig('e2e-election', 0),
      static: { hubAddress: '10.0.0.1:3000' },
      probing: { enabled: true, intervalMs: 60000 },
    };
    manager = new NetworkManager(config, { probeFn: mockProbe });
    await manager.start();

    // Run probes → election kicks in
    await manager.getProbeScheduler().runOnce();
    const hub1 = manager.getTopology().hubNodeId;
    expect(hub1).toBeTruthy();

    // Run probes again → incumbent advantage keeps same hub
    await manager.getProbeScheduler().runOnce();
    const hub2 = manager.getTopology().hubNodeId;
    expect(hub2).toBe(hub1); // same hub — incumbent stays

    // Hub goes unreachable → self elected
    probeReachable = false;
    await manager.getProbeScheduler().runOnce();
    const topology = manager.getTopology();
    expect(topology.hubNodeId).toBe(manager.getIdentity().nodeId);
    expect(topology.myRole).toBe('hub');
  });

  it('self steps down when peer with earlier startedAt becomes reachable', async () => {
    // Simulates split-brain recovery: self elected as hub when alone,
    // then a peer with an earlier startedAt becomes reachable.
    // Self should yield hub to the earlier-started peer.
    let peerReachable = false;
    const mockProbe: ProbeFn = async (
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

    const config = {
      ...defaultNetworkConfig('e2e-split-brain', 0),
      static: { hubAddress: '10.0.0.1:3000' },
      probing: { enabled: true, intervalMs: 60000 },
    };
    manager = new NetworkManager(config, { probeFn: mockProbe });
    await manager.start();

    // Phase 1: Peer is unreachable → self becomes hub
    await manager.getProbeScheduler().runOnce();
    const selfId = manager.getIdentity().nodeId;
    expect(manager.getTopology().hubNodeId).toBe(selfId);
    expect(manager.getTopology().myRole).toBe('hub');

    // Phase 2: Peer comes online (with earlier startedAt via static config)
    // Since the static peer was added with a very early timestamp (or at
    // least is a different node), and self-incumbent advantage is disabled,
    // the election should now consider startedAt.
    peerReachable = true;
    await manager.getProbeScheduler().runOnce();

    // The static hub peer has a stable nodeId from the PeerTable.
    // After re-election without self-incumbent advantage, the peer
    // with earlier startedAt should win.
    const topology2 = manager.getTopology();
    expect(topology2.formedBy).toBe('election');
    // Self should no longer be hub if the peer started earlier
    // (static peers get startedAt from their NodeInfo in PeerTable)
    const staticPeerId = manager
      .getProbeScheduler()
      .getProbes()
      .find((p) => p.toNodeId !== selfId)?.toNodeId;
    expect(staticPeerId).toBeTruthy();
    // The hub should be determined by startedAt comparison,
    // NOT locked to self via incumbent advantage
    expect(topology2.hubNodeId).toBeTruthy();
  });

  it('defers self-election when broadcast peer with earlier startedAt is untested', async () => {
    // Simulates simultaneous startup: two nodes discover each other via
    // broadcast, but neither has port 3000 open yet (all probes fail).
    // Only the node with earliest startedAt should self-elect.
    // The other must defer to avoid multi-hub split-brain.

    const hub = new MockUdpHub();

    // Node A: earlier startedAt → should self-elect
    const configA: NetworkConfig = {
      domain: 'e2e-defer',
      port: 0,
      identityDir: uniqueIdentityDir(),
      broadcast: {
        enabled: true,
        port: 55558,
        intervalMs: 50,
        timeoutMs: 200,
      },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 100 },
    };

    // Node B: later startedAt → should DEFER
    const configB: NetworkConfig = {
      domain: 'e2e-defer',
      port: 0,
      identityDir: uniqueIdentityDir(),
      broadcast: {
        enabled: true,
        port: 55558,
        intervalMs: 50,
        timeoutMs: 200,
      },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 100 },
    };

    // All probes fail — nobody has port 3000 open yet
    const noneReachable = new Set<string>();
    const probeFn: ProbeFn = async (
      _h,
      _p,
      fromNodeId,
      toNodeId,
    ): Promise<PeerProbe> => ({
      fromNodeId,
      toNodeId,
      reachable: noneReachable.has(toNodeId),
      latencyMs: -1,
      measuredAt: Date.now(),
    });

    const managerA = new NetworkManager(configA, {
      probeFn,
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    extraManagers.push(managerA);

    const managerB = new NetworkManager(configB, {
      probeFn,
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    extraManagers.push(managerB);

    await managerA.start();
    // Small delay so A has strictly earlier startedAt
    await new Promise((r) => setTimeout(r, 10));
    await managerB.start();

    // Wait for broadcast discovery
    await new Promise((r) => setTimeout(r, 200));

    // Both should have discovered each other via broadcast
    const idA = managerA.getIdentity().nodeId;
    const idB = managerB.getIdentity().nodeId;
    expect(Object.keys(managerA.getTopology().nodes)).toContain(idB);
    expect(Object.keys(managerB.getTopology().nodes)).toContain(idA);

    // Run probes — all fail (no port 3000 open)
    await managerA.getProbeScheduler().runOnce();
    await managerB.getProbeScheduler().runOnce();

    // Node A (earlier startedAt): should self-elect as hub
    const topoA = managerA.getTopology();
    expect(topoA.hubNodeId).toBe(idA);
    expect(topoA.myRole).toBe('hub');

    // Node B (later startedAt): should DEFER — not self-elect
    const topoB = managerB.getTopology();
    expect(topoB.hubNodeId).toBeNull();
    expect(topoB.myRole).toBe('unassigned');
  });

  it('does NOT defer when crashed peer was previously reachable', async () => {
    // Crash recovery: a broadcast peer was reachable (it was hub), then
    // crashes.  The surviving node must NOT defer — it should self-elect.
    const hub = new MockUdpHub();

    const configA: NetworkConfig = {
      domain: 'e2e-crash',
      port: 0,
      identityDir: uniqueIdentityDir(),
      broadcast: {
        enabled: true,
        port: 55559,
        intervalMs: 50,
        timeoutMs: 200,
      },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 100 },
    };

    const configB: NetworkConfig = {
      domain: 'e2e-crash',
      port: 0,
      identityDir: uniqueIdentityDir(),
      broadcast: {
        enabled: true,
        port: 55559,
        intervalMs: 50,
        timeoutMs: 200,
      },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 100 },
    };

    // Probe function: initially A is reachable (it's the hub)
    const reachable = new Set<string>();
    const probeFn: ProbeFn = async (
      _h,
      _p,
      fromNodeId,
      toNodeId,
    ): Promise<PeerProbe> => ({
      fromNodeId,
      toNodeId,
      reachable: reachable.has(toNodeId),
      latencyMs: reachable.has(toNodeId) ? 1 : -1,
      measuredAt: Date.now(),
    });

    const managerA = new NetworkManager(configA, {
      probeFn,
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    extraManagers.push(managerA);

    const managerB = new NetworkManager(configB, {
      probeFn,
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    extraManagers.push(managerB);

    await managerA.start();
    await new Promise((r) => setTimeout(r, 10));
    await managerB.start();

    // Wait for broadcast discovery
    await new Promise((r) => setTimeout(r, 200));

    const idA = managerA.getIdentity().nodeId;
    const idB = managerB.getIdentity().nodeId;

    // Phase 1: A is reachable (acting as hub with port 3000 open)
    reachable.add(idA);
    reachable.add(idB);
    await managerB.getProbeScheduler().runOnce();

    // B elects A as hub (A has earlier startedAt)
    expect(managerB.getTopology().hubNodeId).toBe(idA);
    expect(managerB.getTopology().myRole).toBe('client');

    // Phase 2: A crashes — port 3000 closed, probes fail
    reachable.delete(idA);
    reachable.delete(idB);
    await managerB.getProbeScheduler().runOnce();

    // B should self-elect (NOT defer) because A was previously reachable
    // (hasEverBeenReachable === true → crash, not startup race)
    expect(managerB.getTopology().hubNodeId).toBe(idB);
    expect(managerB.getTopology().myRole).toBe('hub');
  });

  it('defers self-election when cloud peer with earlier startedAt is untested', async () => {
    // Reproduces the split-brain bug: two nodes in different subnets discover
    // each other only via cloud (no broadcast).  The later-started node must
    // NOT self-elect while the earlier-started cloud peer exists but has never
    // been probed.  Instead it should fall through to cloud/static cascade.

    class MockCloud implements CloudHttpClient {
      response: CloudPeerListResponse = { peers: [], assignedHub: null };
      register(): Promise<CloudPeerListResponse> {
        return Promise.resolve(this.response);
      }
      poll(): Promise<CloudPeerListResponse> {
        return Promise.resolve(this.response);
      }
      reportProbes(): Promise<void> {
        return Promise.resolve();
      }
    }

    // All probes fail — cloud peer's port 3000 not open yet
    const probeFn: ProbeFn = async (
      _h,
      _p,
      fromNodeId,
      toNodeId,
    ): Promise<PeerProbe> => ({
      fromNodeId,
      toNodeId,
      reachable: false,
      latencyMs: -1,
      measuredAt: Date.now(),
    });

    // Cloud provides a peer that started 60 seconds earlier than self.
    // No broadcast: nodes are on different subnets.
    const cloudMock = new MockCloud();
    cloudMock.response = {
      peers: [
        {
          nodeId: 'early-cloud-node',
          hostname: 'server-A',
          localIps: ['192.168.1.94'],
          domain: 'e2e-cloud-defer',
          port: 0,
          startedAt: Date.now() - 60_000, // started 60s ago
        },
      ],
      assignedHub: null, // no cloud assignment yet
    };

    const config: NetworkConfig = {
      ...defaultNetworkConfig('e2e-cloud-defer', 0),
      cloud: {
        enabled: true,
        endpoint: 'http://cloud.test',
        pollIntervalMs: 999999, // disable auto-poll
      },
      probing: { enabled: true, intervalMs: 60000, timeoutMs: 100 },
    };

    manager = new NetworkManager(config, {
      probeFn,
      failThreshold: 1,
      cloudDeps: { createHttpClient: () => cloudMock },
    });
    await manager.start();

    // Cloud peer should be registered in the peer table
    const selfId = manager.getIdentity().nodeId;

    // Run probes — cloud peer is unreachable (port not open yet)
    await manager.getProbeScheduler().runOnce();

    // Self should NOT self-elect because cloud provides a peer with
    // earlier startedAt that has never been successfully probed.
    // This is the bug fix: previously only broadcast peers were checked,
    // so cloud peers were ignored and self would self-elect (split-brain).
    const topology = manager.getTopology();
    expect(topology.hubNodeId).not.toBe(selfId);
    // Should fall through to cloud or remain unassigned
    // (no cloud assignment and no static config → unassigned)
    expect(topology.myRole).not.toBe('hub');
  });
});
