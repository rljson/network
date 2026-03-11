// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeInfo } from './node-info.ts';
import type { PeerProbe } from './peer-probe.ts';

/** Possible roles a node can have in the network */
export const nodeRoles = ['hub', 'client', 'unassigned'] as const;
export type NodeRole = (typeof nodeRoles)[number];

/** Which discovery layer formed the current topology */
export const formedByValues = [
  'broadcast',
  'cloud',
  'election',
  'manual',
  'static',
] as const;
export type FormedBy = (typeof formedByValues)[number];

/** Snapshot of the current network topology */
export interface NetworkTopology {
  /** Network domain */
  domain: string;
  /** NodeId of the current hub, or null if unassigned */
  hubNodeId: string | null;
  /** "ip:port" of the hub, ready to pass to Socket.IO */
  hubAddress: string | null;
  /** Which discovery layer produced this topology */
  formedBy: FormedBy;
  /** Timestamp when this topology was formed */
  formedAt: number;
  /** All known nodes, keyed by nodeId */
  nodes: Record<string, NodeInfo>;
  /** Latest probe results */
  probes: PeerProbe[];
  /** This node's role in the topology */
  myRole: NodeRole;
}

/** Example NetworkTopology for tests and documentation */
export const exampleNetworkTopology: NetworkTopology = {
  domain: 'office-sync',
  hubNodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  hubAddress: '192.168.1.42:3000',
  formedBy: 'broadcast',
  formedAt: 1741123456800,
  nodes: {
    'a1b2c3d4-e5f6-7890-abcd-ef1234567890': {
      nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      hostname: 'WORKSTATION-7',
      localIps: ['192.168.1.42'],
      domain: 'office-sync',
      port: 3000,
      startedAt: 1741123456789,
    },
  },
  probes: [],
  myRole: 'hub',
};
