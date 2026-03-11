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
import { NoLoopbackMockUdpHub, MockUdpHub } from '../helpers/mock-udp.ts';

// .............................................................................

/** Create a unique temp directory for identity persistence */
function uniqueIdentityDir(): string {
  return join(tmpdir(), 'rljson-network-test-' + randomUUID());
}

// .............................................................................

/**
 * Create a mock probe function where given peers are reachable.
 * @param reachable - Set of nodeIds that are reachable
 */
function mockProbeFn(
  reachable: Set<string>,
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
    reachable: reachable.has(toNodeId),
    latencyMs: reachable.has(toNodeId) ? 1 : -1,
    timestamp: Date.now(),
  });
}

// .............................................................................

describe('E2E: Broadcast → Static Fallback', () => {
  const managers: NetworkManager[] = [];

  afterEach(async () => {
    for (const m of managers) {
      await m.stop();
    }
    managers.length = 0;
  });

  // .........................................................................

  it('falls back to static when broadcast self-test fails', async () => {
    const noLoopbackHub = new NoLoopbackMockUdpHub();
    const reachable = new Set<string>();

    const config: NetworkConfig = {
      domain: 'fallback-test',
      port: 3000,
      identityDir: uniqueIdentityDir(),
      broadcast: {
        enabled: true,
        port: 55556,
        intervalMs: 50,
        timeoutMs: 200,
      },
      static: { hubAddress: '192.168.1.100:4000' },
      probing: { enabled: true, intervalMs: 50, timeoutMs: 100 },
    };

    const manager = new NetworkManager(config, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: noLoopbackHub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(manager);

    await manager.start();

    // Broadcast failed (self-test timeout) → should fall back to static
    const topo = manager.getTopology();
    expect(topo.formedBy).toBe('static');
    expect(topo.hubNodeId).toBe('static-hub-192.168.1.100:4000');
  });

  // .........................................................................

  it('falls back to static when broadcast is disabled', async () => {
    const hub = new MockUdpHub();
    const reachable = new Set<string>();

    const config: NetworkConfig = {
      domain: 'disabled-test',
      port: 3000,
      identityDir: uniqueIdentityDir(),
      broadcast: {
        enabled: false,
        port: 55557,
      },
      static: { hubAddress: '10.0.0.50:3000' },
      probing: { enabled: true, intervalMs: 50, timeoutMs: 100 },
    };

    const manager = new NetworkManager(config, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(manager);

    await manager.start();

    const topo = manager.getTopology();
    expect(topo.formedBy).toBe('static');
    expect(topo.hubNodeId).toBe('static-hub-10.0.0.50:3000');
  });

  // .........................................................................

  it('uses broadcast when available (not static)', async () => {
    const hub = new MockUdpHub();
    const reachable = new Set<string>();

    const config: NetworkConfig = {
      domain: 'prefer-broadcast',
      port: 3000,
      identityDir: uniqueIdentityDir(),
      broadcast: {
        enabled: true,
        port: 55558,
        intervalMs: 50,
        timeoutMs: 200,
      },
      static: { hubAddress: '10.0.0.50:3000' },
      probing: { enabled: true, intervalMs: 50, timeoutMs: 100 },
    };

    // Two managers — broadcast works for both
    const managerA = new NetworkManager(config, {
      probeFn: mockProbeFn(reachable),
      failThreshold: 1,
      broadcastDeps: {
        createSocket: hub.createSocketFn(),
        selfTestTimeoutMs: 50,
      },
    });
    managers.push(managerA);

    const configB: NetworkConfig = {
      ...config,
      port: 3001,
      identityDir: uniqueIdentityDir(),
    };
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
    reachable.add(idA);
    reachable.add(idB);

    // Wait for broadcast discovery + probes
    await new Promise((r) => setTimeout(r, 200));

    const topo = managerA.getTopology();
    // When broadcast is active and has peers, formedBy should be 'broadcast'
    // (not 'static', even though static is also configured)
    expect(topo.formedBy).toBe('broadcast');
    expect(topo.hubNodeId).toBeTruthy();
  });
});
