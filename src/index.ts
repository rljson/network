// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// Types
export type { NodeId, NodeInfo } from './types/node-info.ts';
export { exampleNodeInfo } from './types/node-info.ts';

export type { PeerProbe } from './types/peer-probe.ts';
export { examplePeerProbe } from './types/peer-probe.ts';

export type {
  NodeRole,
  FormedBy,
  NetworkTopology,
} from './types/network-topology.ts';
export {
  nodeRoles,
  formedByValues,
  exampleNetworkTopology,
} from './types/network-topology.ts';

export type {
  BroadcastConfig,
  CloudConfig,
  StaticConfig,
  ProbingConfig,
  NetworkConfig,
} from './types/network-config.ts';
export { defaultNetworkConfig } from './types/network-config.ts';

export type {
  TopologyChangedEvent,
  RoleChangedEvent,
  HubChangedEvent,
  NetworkEventMap,
  NetworkEventName,
} from './types/network-events.ts';
export {
  networkEventNames,
  exampleTopologyChangedEvent,
  exampleRoleChangedEvent,
  exampleHubChangedEvent,
} from './types/network-events.ts';

// Identity
export type {
  NodeIdentityDeps,
  CreateNodeIdentityOptions,
} from './identity/node-identity.ts';
export {
  NodeIdentity,
  parseLocalIps,
  defaultNodeIdentityDeps,
} from './identity/node-identity.ts';

// Layers
export type {
  DiscoveryLayer,
  DiscoveryLayerEvents,
  DiscoveryLayerEventName,
} from './layers/discovery-layer.ts';
export type {
  UdpSocket,
  RemoteInfo,
  CreateUdpSocket,
  BroadcastLayerDeps,
} from './layers/broadcast-layer.ts';
export {
  BroadcastLayer,
  defaultCreateUdpSocket,
} from './layers/broadcast-layer.ts';
export type {
  CloudHttpClient,
  CloudPeerListResponse,
  CreateCloudHttpClient,
  CloudLayerDeps,
} from './layers/cloud-layer.ts';
export {
  CloudLayer,
  defaultCreateCloudHttpClient,
} from './layers/cloud-layer.ts';
export { ManualLayer } from './layers/manual-layer.ts';
export { StaticLayer } from './layers/static-layer.ts';

// Peer Table
export type { PeerTableEvents } from './peer-table.ts';
export { PeerTable } from './peer-table.ts';

// Election
export type {
  ElectionResult,
  ElectionReason,
} from './election/hub-election.ts';
export { electHub } from './election/hub-election.ts';

// Probing
export type { ProbeOptions } from './probing/peer-prober.ts';
export { probePeer } from './probing/peer-prober.ts';
export type {
  ProbeFn,
  ProbeSchedulerEvents,
  ProbeSchedulerEventName,
  ProbeSchedulerOptions,
} from './probing/probe-scheduler.ts';
export { ProbeScheduler } from './probing/probe-scheduler.ts';

// Network Manager
export type {
  NetworkManagerEvents,
  NetworkManagerEventName,
  NetworkManagerOptions,
} from './network-manager.ts';
export { NetworkManager } from './network-manager.ts';
