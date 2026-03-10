<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/network

Self-organizing network topology for the RLJSON ecosystem. Handles peer
discovery, hub election, and topology formation — enabling nodes to
automatically form star-topology networks without pre-assigned roles or
hardcoded IPs.

## Install

```bash
pnpm add @rljson/network
```

## Key Concepts

| Concept         | Description                                                      |
| --------------- | ---------------------------------------------------------------- |
| **Domain**      | Groups nodes that should discover each other (not a DNS domain)  |
| **Hub**         | Central node elected automatically — all others are clients      |
| **Discovery**   | Fallback cascade: Broadcast → Cloud → Static + Manual override   |
| **Hub Election**| Incumbent advantage + earliest `startedAt` timestamp wins        |

## Types

### NodeInfo

Describes a node in the network:

```typescript
import type { NodeInfo } from '@rljson/network';

const node: NodeInfo = {
  nodeId: 'a1b2c3d4-...',      // Persistent UUID
  hostname: 'WORKSTATION-7',    // os.hostname()
  localIps: ['192.168.1.42'],   // Non-internal IPv4 addresses
  domain: 'office-sync',        // Network group
  port: 3000,                   // Listen port when hub
  startedAt: 1741123456789,     // Startup timestamp
};
```

### PeerProbe

Result of probing a peer's reachability:

```typescript
import type { PeerProbe } from '@rljson/network';

const probe: PeerProbe = {
  fromNodeId: 'node-a',
  toNodeId: 'node-b',
  reachable: true,
  latencyMs: 12,
  measuredAt: 1741123456800,
};
```

### NetworkTopology

Snapshot of the current network layout:

```typescript
import type { NetworkTopology } from '@rljson/network';

const topo: NetworkTopology = {
  domain: 'office-sync',
  hubNodeId: 'a1b2c3d4-...',
  hubAddress: '192.168.1.42:3000',
  formedBy: 'broadcast',         // 'broadcast' | 'cloud' | 'static' | 'manual'
  formedAt: 1741123456800,
  nodes: { /* NodeInfo by nodeId */ },
  probes: [ /* PeerProbe[] */ ],
  myRole: 'hub',                 // 'hub' | 'client' | 'unassigned'
};
```

### NetworkConfig

Configuration for the discovery layers:

```typescript
import { defaultNetworkConfig } from '@rljson/network';

// Quick start — broadcast enabled, cloud/static off
const config = defaultNetworkConfig('office-sync', 3000);

// Full configuration
import type { NetworkConfig } from '@rljson/network';

const fullConfig: NetworkConfig = {
  domain: 'office-sync',
  port: 3000,
  identityDir: '/opt/myapp/identity',  // Default: ~/.rljson-network/
  broadcast: { enabled: true, port: 41234, intervalMs: 5000 },
  cloud: { enabled: true, endpoint: 'https://cloud.example.com', apiKey: '...' },
  static: { hubAddress: '192.168.1.100:3000' },
  probing: { enabled: true, intervalMs: 10000, timeoutMs: 2000 },
};
```

### Network Events

Events emitted by the network manager:

```typescript
import type { NetworkEventMap } from '@rljson/network';
import { networkEventNames } from '@rljson/network';

// Event names: 'topology-changed', 'role-changed', 'hub-changed',
//              'peer-joined', 'peer-left'
```

## NodeIdentity

Persistent node identity — generates a UUID on first run, reads the same
UUID on subsequent runs (same machine = same identity):

```typescript
import { NodeIdentity } from '@rljson/network';

const identity = await NodeIdentity.create({
  domain: 'office-sync',
  port: 3000,
  // identityDir: '/custom/path',  // Default: ~/.rljson-network/
});

console.log(identity.nodeId);    // Persistent UUID
console.log(identity.hostname);  // Machine hostname
console.log(identity.localIps);  // ['192.168.1.42']

const info = identity.toNodeInfo(); // Plain NodeInfo object
```

## Example

[src/example.ts](src/example.ts)
