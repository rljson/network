// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createServer, type Server, type AddressInfo } from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';

import { NetworkManager } from '../../src/network-manager';
import { defaultNetworkConfig } from '../../src/types/network-config';
import type { PeerProbe } from '../../src/types/peer-probe';
import type { ProbeFn } from '../../src/probing/probe-scheduler';

// .............................................................................

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

  afterEach(async () => {
    if (manager?.isRunning()) {
      await manager.stop();
    }
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
      ...defaultNetworkConfig('e2e-probing', 3000),
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
      ...defaultNetworkConfig('e2e-noprobe', 3000),
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
      ...defaultNetworkConfig('e2e-manual', 3000),
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
      ...defaultNetworkConfig('e2e-election', 3000),
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
});
