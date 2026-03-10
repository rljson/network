// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { exampleNodeInfo } from './types/node-info.ts';
import { examplePeerProbe } from './types/peer-probe.ts';
import { exampleNetworkTopology } from './types/network-topology.ts';
import { defaultNetworkConfig } from './types/network-config.ts';

export const example = () => {
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
};

/*
// Run via "npx vite-node src/example.ts"
example();
*/
