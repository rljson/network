// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// Types
export { exampleNodeInfo } from './types/node-info.ts';
export type { NodeId, NodeInfo } from './types/node-info.ts';

export { examplePeerProbe } from './types/peer-probe.ts';
export type { PeerProbe } from './types/peer-probe.ts';

export {
  exampleNetworkTopology,
  formedByValues,
  nodeRoles,
} from './types/network-topology.ts';
export type {
  FormedBy,
  NetworkTopology,
  NodeRole,
} from './types/network-topology.ts';

export { defaultNetworkConfig } from './types/network-config.ts';
export type {
  BroadcastConfig,
  CloudConfig,
  NetworkConfig,
  ProbingConfig,
  StaticConfig,
} from './types/network-config.ts';

export {
  exampleHubChangedEvent,
  exampleNetworkLogEntry,
  exampleRoleChangedEvent,
  exampleTopologyChangedEvent,
  networkEventNames,
} from './types/network-events.ts';
export type {
  HubChangedEvent,
  NetworkEventMap,
  NetworkEventName,
  NetworkLogEntry,
  RoleChangedEvent,
  TopologyChangedEvent,
} from './types/network-events.ts';

// Identity
export {
  NodeIdentity,
  defaultNodeIdentityDeps,
  parseLocalIps,
} from './identity/node-identity.ts';
export type {
  CreateNodeIdentityOptions,
  NodeIdentityDeps,
} from './identity/node-identity.ts';

// Layers
export {
  BroadcastLayer,
  defaultCreateUdpSocket,
} from './layers/broadcast-layer.ts';
export type {
  BroadcastLayerDeps,
  CreateUdpSocket,
  RemoteInfo,
  UdpSocket,
} from './layers/broadcast-layer.ts';
export {
  CloudLayer,
  defaultCreateCloudHttpClient,
} from './layers/cloud-layer.ts';
export type {
  CloudHttpClient,
  CloudLayerDeps,
  CloudPeerListResponse,
  CreateCloudHttpClient,
} from './layers/cloud-layer.ts';
export type {
  DiscoveryLayer,
  DiscoveryLayerEventName,
  DiscoveryLayerEvents,
} from './layers/discovery-layer.ts';
export { ManualLayer } from './layers/manual-layer.ts';
export { StaticLayer } from './layers/static-layer.ts';

// Peer Table
export { PeerTable } from './peer-table.ts';
export type { PeerTableEvents } from './peer-table.ts';

// Election
export { electHub } from './election/hub-election.ts';
export type {
  ElectionReason,
  ElectionResult,
} from './election/hub-election.ts';

// Probing
export { probePeer } from './probing/peer-prober.ts';
export type { ProbeOptions } from './probing/peer-prober.ts';
export {
  ProbeListener,
  defaultProbeListenerDeps,
} from './probing/probe-listener.ts';
export type { ProbeListenerDeps } from './probing/probe-listener.ts';
export { ProbeScheduler } from './probing/probe-scheduler.ts';
export type {
  ProbeFn,
  ProbeSchedulerEventName,
  ProbeSchedulerEvents,
  ProbeSchedulerOptions,
} from './probing/probe-scheduler.ts';

// Network Manager
export { NetworkManager } from './network-manager.ts';
export type {
  NetworkManagerEventName,
  NetworkManagerEvents,
  NetworkManagerOptions,
} from './network-manager.ts';
