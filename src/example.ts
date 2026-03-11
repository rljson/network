// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { exampleNodeInfo } from './types/node-info.ts';
import type { NodeInfo } from './types/node-info.ts';
import { examplePeerProbe } from './types/peer-probe.ts';
import { exampleNetworkTopology } from './types/network-topology.ts';
import { defaultNetworkConfig } from './types/network-config.ts';
import { NetworkManager } from './network-manager.ts';
import { electHub } from './election/hub-election.ts';

export const example = async () => {
  const l = console.log;
  const h1 = (text: string) => l(`${text}`);
  const h2 = (text: string) => l(`  ${text}`);
  const p = (text: string) => l(`    ${text}`);

  h1('NodeInfo');
  h2('Describes a node in the network');
  p(JSON.stringify(exampleNodeInfo, null, 2));

  h1('PeerProbe');
  h2('Result of probing a peer');
  p(JSON.stringify(examplePeerProbe, null, 2));

  h1('NetworkTopology');
  h2('Snapshot of the current network topology');
  p(JSON.stringify(exampleNetworkTopology, null, 2));

  h1('NetworkConfig');
  h2('Default configuration with broadcast enabled');
  p(JSON.stringify(defaultNetworkConfig('office-sync', 3000), null, 2));

  h1('HubElection');
  h2('Deterministic hub election from candidates + probes');
  const candidates: NodeInfo[] = [
    {
      nodeId: 'node-a',
      hostname: 'ws-a',
      localIps: ['10.0.0.1'],
      domain: 'test',
      port: 3000,
      startedAt: 1000,
    },
    {
      nodeId: 'node-b',
      hostname: 'ws-b',
      localIps: ['10.0.0.2'],
      domain: 'test',
      port: 3000,
      startedAt: 900,
    },
    {
      nodeId: 'node-c',
      hostname: 'ws-c',
      localIps: ['10.0.0.3'],
      domain: 'test',
      port: 3000,
      startedAt: 1100,
    },
  ];
  const probes = [
    { ...examplePeerProbe, toNodeId: 'node-a', reachable: true },
    { ...examplePeerProbe, toNodeId: 'node-b', reachable: true },
    { ...examplePeerProbe, toNodeId: 'node-c', reachable: false },
  ];
  const result = electHub(candidates, probes, null, 'node-a');
  p(`Winner: ${result.hubId}, reason: ${result.reason}`);
  p('(node-b wins: earliest startedAt among reachable peers)');

  h1('NetworkManager');
  h2('Start with static hub → manual override → revert');

  const config = {
    ...defaultNetworkConfig('office-sync', 3000),
    static: { hubAddress: '192.168.1.100:3000' },
  };
  const manager = new NetworkManager(config);

  manager.on('role-changed', (e) => {
    p(`Role changed: ${e.previous} → ${e.current}`);
  });

  await manager.start();
  p(
    `Topology: role=${manager.getTopology().myRole}, formedBy=${manager.getTopology().formedBy}`,
  );

  manager.assignHub('custom-hub');
  p(`After manual override: formedBy=${manager.getTopology().formedBy}`);

  manager.clearOverride();
  p(`After clearing override: formedBy=${manager.getTopology().formedBy}`);

  await manager.stop();
  p('Manager stopped');
};

/*
// Run via "npx vite-node src/example.ts"
example();
*/
