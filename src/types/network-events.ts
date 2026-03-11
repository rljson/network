// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// .............................................................................

import type { NodeInfo } from './node-info.ts';
import type { NetworkTopology, NodeRole } from './network-topology.ts';
import { exampleNetworkTopology } from './network-topology.ts';

/** Emitted when the network topology changes */
export interface TopologyChangedEvent {
  topology: NetworkTopology;
}

/** Emitted when this node's role changes */
export interface RoleChangedEvent {
  previous: NodeRole;
  current: NodeRole;
}

/** Emitted when the hub node changes */
export interface HubChangedEvent {
  previousHub: string | null;
  currentHub: string | null;
}

/** Map of all events emitted by NetworkManager */
export interface NetworkEventMap {
  'topology-changed': TopologyChangedEvent;
  'role-changed': RoleChangedEvent;
  'hub-changed': HubChangedEvent;
  'peer-joined': NodeInfo;
  'peer-left': string;
}

/** All valid network event names */
export const networkEventNames = [
  'topology-changed',
  'role-changed',
  'hub-changed',
  'peer-joined',
  'peer-left',
] as const;

export type NetworkEventName = (typeof networkEventNames)[number];

// .............................................................................

/** Example TopologyChangedEvent for tests and documentation */
export const exampleTopologyChangedEvent: TopologyChangedEvent = {
  topology: exampleNetworkTopology,
};

/** Example RoleChangedEvent for tests and documentation */
export const exampleRoleChangedEvent: RoleChangedEvent = {
  previous: 'unassigned',
  current: 'hub',
};

/** Example HubChangedEvent for tests and documentation */
export const exampleHubChangedEvent: HubChangedEvent = {
  previousHub: null,
  currentHub: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
};
