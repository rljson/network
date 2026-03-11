// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

/** Unique identifier for a node in the network */
export type NodeId = string;

/** Information about a node in the network */
export interface NodeInfo {
  /** Persistent UUID, generated once, stored on disk */
  nodeId: NodeId;
  /** Machine name (os.hostname()) */
  hostname: string;
  /** All non-internal IPv4 addresses */
  localIps: string[];
  /** Network domain — which group of nodes discover each other */
  domain: string;
  /** Port this node listens on when hub */
  port: number;
  /** Timestamp of node start */
  startedAt: number;
}

/** Example NodeInfo for tests and documentation */
export const exampleNodeInfo: NodeInfo = {
  nodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  hostname: 'WORKSTATION-7',
  localIps: ['192.168.1.42'],
  domain: 'office-sync',
  port: 3000,
  startedAt: 1741123456789,
};
