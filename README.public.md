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

| Concept          | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| **Domain**       | Groups nodes that should discover each other (not a DNS domain) |
| **Hub**          | Central node elected automatically — all others are clients     |
| **Discovery**    | Fallback cascade: Broadcast → Cloud → Static + Manual override  |
| **Hub Election** | Incumbent advantage + earliest `startedAt` timestamp wins       |

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
  formedBy: 'broadcast',         // 'broadcast' | 'cloud' | 'election' | 'static' | 'manual'
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

## Discovery Layers

All layers implement the `DiscoveryLayer` interface:

```typescript
import type { DiscoveryLayer } from '@rljson/network';
// Methods: start(), stop(), isActive(), getPeers(), getAssignedHub(), on(), off()
```

### ManualLayer

Always-present manual override. Cannot be disabled:

```typescript
import { ManualLayer } from '@rljson/network';

const manual = new ManualLayer();
await manual.start(identity);

manual.assignHub('specific-node-id');   // Force a hub
manual.clearOverride();                 // Return to cascade
```

### StaticLayer

Last-resort fallback — reads a hardcoded hub address from config:

```typescript
import { StaticLayer } from '@rljson/network';

const staticLayer = new StaticLayer({ hubAddress: '192.168.1.100:3000' });
const started = await staticLayer.start(identity);
// started = true (has config), creates synthetic peer for hub

const noConfig = new StaticLayer();
const started2 = await noConfig.start(identity);
// started2 = false (no hubAddress configured)
```

## PeerTable

Merged view of all peers from all discovery layers. Deduplicates by nodeId:

```typescript
import { PeerTable } from '@rljson/network';

const table = new PeerTable();
table.setSelfId(identity.nodeId);

table.attachLayer(staticLayer);    // Import peers + subscribe to events
table.attachLayer(manualLayer);

table.on('peer-joined', (peer) => console.log('New peer:', peer.nodeId));
table.on('peer-left', (nodeId) => console.log('Lost peer:', nodeId));

console.log(table.getPeers());    // All known peers
console.log(table.size);          // Number of peers
```

## NetworkManager

Central orchestrator — starts layers, merges peer tables, applies cascade
logic, and emits topology events:

```typescript
import { NetworkManager, defaultNetworkConfig } from '@rljson/network';

const config = {
  ...defaultNetworkConfig('office-sync', 3000),
  static: { hubAddress: '192.168.1.100:3000' },
};
const manager = new NetworkManager(config);

manager.on('topology-changed', (e) => {
  console.log('Topology:', e.topology.myRole, e.topology.formedBy);
});
manager.on('role-changed', (e) => {
  console.log(`Role: ${e.previous} → ${e.current}`);
});
manager.on('hub-changed', (e) => {
  console.log(`Hub: ${e.previousHub} → ${e.currentHub}`);
});

await manager.start();

const topology = manager.getTopology();
// { myRole: 'client', formedBy: 'static', hubAddress: '192.168.1.100:3000', ... }

// Manual override supersedes cascade
manager.assignHub('custom-hub-id');
// Now formedBy: 'manual'

// Revert to cascade
manager.clearOverride();
// Back to formedBy: 'static'

await manager.stop();
```

### Hub Decision Cascade

The `NetworkManager` evaluates hub assignment in this order:

1. **Manual override** → human knows best
2. **Election via probing** → probes determine reachable peers, election picks hub
3. **Cloud** → cross-network (not yet implemented)
4. **Static config** → last resort
5. **Nothing** → `myRole = 'unassigned'`

## Hub Election

Pure deterministic election algorithm — no I/O, no side effects:

```typescript
import { electHub } from '@rljson/network';
import type { ElectionResult } from '@rljson/network';

const candidates = [
  { nodeId: 'node-a', host: '10.0.0.1', port: 3000, ... startedAt: 1000 },
  { nodeId: 'node-b', host: '10.0.0.2', port: 3000, ... startedAt: 900 },
];
const probes = [
  { fromNodeId: 'self', toNodeId: 'node-a', reachable: true, latencyMs: 5, measuredAt: Date.now() },
  { fromNodeId: 'self', toNodeId: 'node-b', reachable: true, latencyMs: 3, measuredAt: Date.now() },
];

const result: ElectionResult = electHub(candidates, probes, null, 'self');
// result.hubId = 'node-b' (earliest startedAt)
// result.reason = 'earliest-start'
```

Election rules:
1. Filter candidates to reachable peers only (self is always reachable)
2. **Incumbent advantage**: keep current hub if still reachable
3. **Earliest `startedAt`** wins among reachable candidates
4. **Tiebreaker**: lexicographic `nodeId` comparison

## Probing

### PeerProber

Real TCP connect probe — tests whether a peer is reachable:

```typescript
import { probePeer } from '@rljson/network';

const probe = await probePeer('192.168.1.42', 3000, 'my-node', 'peer-node');
// { reachable: true, latencyMs: 2.45, fromNodeId: 'my-node', toNodeId: 'peer-node', ... }

// With custom timeout
const probe2 = await probePeer('10.0.0.1', 3000, 'my-node', 'remote', { timeoutMs: 500 });
```

### ProbeScheduler

Periodically probes all known peers and detects state changes:

```typescript
import { ProbeScheduler } from '@rljson/network';

const scheduler = new ProbeScheduler({
  intervalMs: 5000,
  timeoutMs: 2000,
  failThreshold: 3,   // Consecutive failures before 'unreachable' (default: 3)
});
scheduler.start('my-node-id');
scheduler.setPeers([peerA, peerB]); // NodeInfo[]

scheduler.on('probes-updated', (probes) => {
  console.log('All probe results:', probes);
});
scheduler.on('peer-unreachable', (nodeId, probe) => {
  console.log(`${nodeId} went down!`);
});
scheduler.on('peer-reachable', (nodeId, probe) => {
  console.log(`${nodeId} came back!`);
});

// Manual single cycle (useful for tests)
const results = await scheduler.runOnce();

scheduler.stop();
```

The `NetworkManager` creates and manages a `ProbeScheduler` internally.
Access it via `manager.getProbeScheduler()` for advanced use.

**Flap dampening**: A peer must fail `failThreshold` consecutive probes
(default: 3) before being declared unreachable. A single success resets
the counter immediately. This prevents flapping on transient network glitches.

## Example

[src/example.ts](src/example.ts)
