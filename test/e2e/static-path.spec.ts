// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, afterEach } from 'vitest';

import { NetworkManager } from '../../src/network-manager';
import { defaultNetworkConfig } from '../../src/types/network-config';
import type { RoleChangedEvent, HubChangedEvent } from '../../src/types/network-events';

// .............................................................................

/**
 * End-to-end test: Static configuration path.
 *
 * Scenario:
 *   1. Node starts with static.hubAddress configured
 *   2. Node becomes client (formedBy: 'static')
 *   3. Manual override supersedes static
 *   4. Clearing override reverts to static
 *
 * This validates the full cascade for Try 3 + Override path.
 */
describe('E2E: Static path', () => {
  let manager: NetworkManager;

  afterEach(async () => {
    if (manager?.isRunning()) {
      await manager.stop();
    }
  });

  it('full lifecycle: static → manual → revert → static', async () => {
    // -----------------------------------------------------------------------
    // Setup: node with static hub configured
    // -----------------------------------------------------------------------
    const config = {
      ...defaultNetworkConfig('e2e-domain', 3000),
      static: { hubAddress: '192.168.1.100:3000' },
    };
    manager = new NetworkManager(config);

    const roleChanges: RoleChangedEvent[] = [];
    const hubChanges: HubChangedEvent[] = [];

    manager.on('role-changed', (e) => roleChanges.push(e));
    manager.on('hub-changed', (e) => hubChanges.push(e));

    // -----------------------------------------------------------------------
    // Step 1: Start → becomes client via static config
    // -----------------------------------------------------------------------
    await manager.start();

    let topology = manager.getTopology();
    expect(topology.myRole).toBe('client');
    expect(topology.formedBy).toBe('static');
    expect(topology.hubNodeId).toBe('static-hub-192.168.1.100:3000');
    expect(topology.hubAddress).toBe('192.168.1.100:3000');
    expect(topology.domain).toBe('e2e-domain');

    // Verify events fired on start
    expect(roleChanges).toContainEqual({
      previous: 'unassigned',
      current: 'client',
    });
    expect(hubChanges).toContainEqual({
      previousHub: null,
      currentHub: 'static-hub-192.168.1.100:3000',
    });

    // -----------------------------------------------------------------------
    // Step 2: Manual override supersedes static
    // -----------------------------------------------------------------------
    roleChanges.length = 0;
    hubChanges.length = 0;

    manager.assignHub('manual-hub-node');

    topology = manager.getTopology();
    expect(topology.myRole).toBe('client');
    expect(topology.formedBy).toBe('manual');
    expect(topology.hubNodeId).toBe('manual-hub-node');

    expect(hubChanges).toContainEqual({
      previousHub: 'static-hub-192.168.1.100:3000',
      currentHub: 'manual-hub-node',
    });

    // -----------------------------------------------------------------------
    // Step 3: Clear override → reverts to static
    // -----------------------------------------------------------------------
    hubChanges.length = 0;

    manager.clearOverride();

    topology = manager.getTopology();
    expect(topology.myRole).toBe('client');
    expect(topology.formedBy).toBe('static');
    expect(topology.hubNodeId).toBe('static-hub-192.168.1.100:3000');
    expect(topology.hubAddress).toBe('192.168.1.100:3000');

    expect(hubChanges).toContainEqual({
      previousHub: 'manual-hub-node',
      currentHub: 'static-hub-192.168.1.100:3000',
    });

    // -----------------------------------------------------------------------
    // Step 4: Stop → clean shutdown
    // -----------------------------------------------------------------------
    await manager.stop();
    expect(manager.isRunning()).toBe(false);
  });

  it('node without static config stays unassigned', async () => {
    const config = defaultNetworkConfig('e2e-domain', 3000);
    manager = new NetworkManager(config);

    await manager.start();

    const topology = manager.getTopology();
    expect(topology.myRole).toBe('unassigned');
    expect(topology.hubNodeId).toBeNull();
    expect(topology.hubAddress).toBeNull();
  });

  it('self-assignment as hub works correctly', async () => {
    const config = defaultNetworkConfig('e2e-domain', 3000);
    manager = new NetworkManager(config);

    await manager.start();

    const selfId = manager.getIdentity().nodeId;
    manager.assignHub(selfId);

    const topology = manager.getTopology();
    expect(topology.myRole).toBe('hub');
    expect(topology.hubNodeId).toBe(selfId);
    expect(topology.formedBy).toBe('manual');
  });
});
