# Self-Organizing Network Topology for RLJSON

*How we're evolving a centralized client-server sync system into a network of equalized, self-organizing nodes — without rewriting the protocol.*

---

## The Problem

RLJSON is a content-addressed data format built for distributed collaboration. Every piece of data is immutable, identified by its hash. Trees of files become DAGs of hashed nodes. Insert histories form append-only logs. The data model is inherently decentralized — there are no conflicts, no locks, no coordination required at the data level.

But when it comes to actually moving data between machines, the current system tells a different story: one machine runs `sl-server`, the others run `sl-client`, and the server's IP address is hardcoded in every client's config file. If the server goes down, sync stops. If you want a different machine to be the server, you manually reconfigure everything.

**The data is decentralized. The network is centralized. That tension is what this document addresses.**

## Why the Star Topology Stays

Before diving into the solution, let's be clear about what we're *not* changing: the star topology.

A star — one hub relays, N clients connect — gives us:

- **Natural total ordering**: The hub serializes all writes. No need for vector clocks, CRDTs, or merge strategies.
- **Simplicity**: One socket per client. No N×N mesh connections. No routing tables.
- **Proven protocol**: The existing sync protocol (`@rljson/server`) handles multicast, bootstrap, dedup, gap-fill, and ACK aggregation. It works. We don't want to redesign it.

What we're changing is not the topology shape — it's **who decides the roles** and **how nodes find each other**.

## The Vision: Equalized Nodes

Today, server and client are separate executables with separate configs. Tomorrow, every node runs the same software. On startup, a node doesn't know whether it's the hub or a client. It discovers its peers, they collectively determine who the hub should be, and each node assumes its role. If the hub goes down, the remaining nodes re-elect and reform — automatically.

No pre-assigned roles. No hardcoded IPs. No human intervention for routine topology changes.

---

## The RLJSON Ecosystem — Where Things Stand

To understand how the network layer integrates, you need to see the full stack:

### Package Overview

| Package            | Purpose                                                                                                   | Key Classes                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `@rljson/rljson`   | Core data model: content-addressed tables, hash-linked trees, DAG-based insert history, sync event naming | `Rljson`, `Route`, `SyncConfig`, `syncEvents()` |
| `@rljson/io`       | Storage abstraction: read/write RLJSON data with pluggable backends                                       | `Io`, `IoMem`, `IoMulti`, `IoPeer`, `Socket`    |
| `@rljson/bs`       | Blob storage: content-addressed binary data with the same layered architecture                            | `Bs`, `BsMem`, `BsMulti`, `BsPeer`              |
| `@rljson/db`       | Database operations and network-aware sync connector                                                      | `Db`, `Connector`                               |
| `@rljson/server`   | Client-server protocol: multicast relay, bootstrap, ACK aggregation, gap-fill                             | `Server`, `Client`, `SocketIoBridge`            |
| `@rljson/fs-agent` | Filesystem ↔ database sync: scans folders, watches for changes, restores from trees                       | `FsAgent`, `FsScanner`, `FsBlobAdapter`         |

### How Data Flows Today

A client syncs a folder to a remote server:

```
Filesystem (chokidar watcher)
    │  file changed
    ▼
FsAgent.syncToDb()
    │  scan → hash → store tree
    ▼
Db.write() → InsertHistory updated
    │  Connector observes new ref
    ▼
Connector.send(ref) → Socket.IO → Server
    │  Server multicasts to all other clients
    ▼
Other Client's Connector.listen(callback)
    │  receives ref, fetches tree via IoPeer
    ▼
FsAgent.syncFromDb()
    │  compare content, restore files
    ▼
Filesystem updated
```

Every box in this chain works. The network layer we're building sits *outside* this chain — it only decides **which machine runs the Server and which run the Client**.

### The Two-Layer Sandwich

Both `Server` and `Client` use a layered storage model that makes the network transparent to the sync protocol:

```
Server's IoMulti:
  Priority 1: IoMem (local in-memory cache)
  Priority 2: IoPeer(clientA) → IoPeer(clientB) → ...
  (reads go local-first, writes broadcast to all)

Client's IoMulti:
  Priority 1: IoMem (local in-memory cache)
  Priority 2: IoPeer(server)
  (reads go local-first, misses fetch from server)
```

This architecture means the **Server is stateless**. It caches data in `IoMem` but persists nothing. The filesystem on each client is the durable store. This is crucial for hub migration: when a new hub is elected, no data needs to be transferred to the new server — all data lives on the clients' filesystems already.

### The Bootstrap Protocol

When a new client connects to the server, the following happens in sequence:

1. **Server.addSocket()**: Creates `IoPeer`/`BsPeer` for the new client, rebuilds its `IoMulti`/`BsMulti` to include the new peer, installs multicast listeners
2. **Server._sendBootstrap()**: Sends the latest known ref to the new client via the bootstrap event channel
3. **Client.init()**: Sets up its own `IoMulti` (local + remote peer), creates `Db` and `Connector`
4. **Connector._registerBootstrapHandler()**: Receives the bootstrap ref, feeds it through `_processIncoming()` (dedup + gap detection)
5. **Connector → listener callbacks**: The `FsAgent.syncFromDb()` callback receives the ref, fetches the tree, compares content, and restores files

This entire sequence must work correctly even during hub migration — when the new hub starts and existing clients reconnect, the bootstrap must converge all nodes to the same state.

---

## Introducing `@rljson/network`

### Design Principles

1. **Zero RLJSON dependencies**: The network package knows nothing about Io, Bs, Db, trees, hashes, or sync. It only knows about nodes, peers, and topology.
2. **Event-driven**: The package emits events. The consumer reacts. No callbacks injected into the network layer.
3. **Layered discovery with automatic fallback**: Multiple discovery mechanisms are tried in order of autonomy — the most automatic layer wins. Less autonomous layers activate only when more autonomous ones fail.
4. **Continuous evaluation**: No phases, no state machines. Rules are evaluated continuously. The topology is always converging.

### The DiscoveryLayer Interface

Every discovery mechanism implements the same interface:

```typescript
interface DiscoveryLayer {
  readonly name: string;          // 'broadcast' | 'cloud' | 'static' | 'manual'

  start(identity: NodeIdentity): Promise<boolean>;  // false = not available
  stop(): Promise<void>;
  isActive(): boolean;

  getPeers(): NodeInfo[];
  getAssignedHub(): NodeId | null;  // Some layers dictate the hub

  on(event: 'peer-discovered', cb: (peer: NodeInfo) => void): void;
  on(event: 'peer-lost', cb: (nodeId: string) => void): void;
  on(event: 'hub-assigned', cb: (nodeId: string) => void): void;
}
```

This is the contract. Each layer decides **how** to discover peers. The `NetworkManager` tries layers in order and uses the first one that produces a result.

### The Fallback Cascade

The core idea: **try the most autonomous discovery first, fall back to less autonomous options step by step.** Manual override can intervene at any point.

```
Node starts
    │
    ▼
┌─────────────────────────────────────┐
│  Step 1: UDP Broadcast              │  ← zero-config, fully automatic
│  Send broadcast, listen for peers   │
│  Self-test: can I hear my own       │
│  broadcast?                         │
│                                     │
│  YES → peers discovered             │──→ Hub election among peers
│        → TOPOLOGY FORMED            │    → DONE (formedBy: 'broadcast')
│                                     │
│  NO  → broadcast blocked or         │
│        no peers on this LAN         │
└─────────────┬───────────────────────┘
              │ fallback
              ▼
┌─────────────────────────────────────┐
│  Step 2: Cloud Service (optional)   │  ← requires config + internet
│  Register with cloud endpoint       │
│  Receive peer list from cloud       │
│  Probe peers, report results        │
│                                     │
│  YES → cloud assigns hub            │──→ TOPOLOGY FORMED
│        → DONE (formedBy: 'cloud')   │    (formedBy: 'cloud')
│                                     │
│  NO  → cloud not configured,        │
│        endpoint unreachable, or     │
│        cloud has no peers yet       │
└─────────────┬───────────────────────┘
              │ fallback
              ▼
┌─────────────────────────────────────┐
│  Step 3: Static Config              │  ← hardcoded, last resort
│  Read hubAddress from config file   │
│                                     │
│  YES → connect to configured hub    │──→ TOPOLOGY FORMED
│        → DONE (formedBy: 'static')  │    (formedBy: 'static')
│                                     │
│  NO  → no static config provided    │
└─────────────┬───────────────────────┘
              │ nothing worked
              ▼
┌─────────────────────────────────────┐
│  myRole = 'unassigned'              │
│  Keep retrying all layers           │
│  periodically                       │
└─────────────────────────────────────┘

At ANY point:
┌─────────────────────────────────────┐
│  Manual / UI Override               │  ← human intervention
│  User assigns hub via dashboard     │
│  → overrides whatever the cascade   │
│    decided (formedBy: 'manual')     │
│  Clearing the override returns      │
│  control to the automatic cascade   │
└─────────────────────────────────────┘
```

**Why this order?**

| Position     | Layer             | Required?          | Why here?                                                                                                                                                                                                                                        |
| ------------ | ----------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Try 1**    | **UDP Broadcast** | **always on**      | Fully automatic. Zero configuration needed. Works out of the box on any flat LAN. This is the *ideal* path — if it works, nothing else is needed.                                                                                                |
| **Try 2**    | **Cloud Service** | **optional**       | First fallback. When broadcast fails (VLANs, firewalls, cross-subnet), the cloud can bridge the gap. Requires explicit cloud configuration. Not needed in most LAN setups.                                                                       |
| **Try 3**    | **Static Config** | **optional**       | Last resort. A hardcoded `hubAddress` in a config file. This is what the *current* system does. Only needed when both broadcast and cloud are unavailable.                                                                                       |
| **Override** | **Manual / UI**   | **always present** | Not part of the cascade. It's an escape hatch. A human looks at the topology dashboard, decides the automatic result is wrong, and forces a specific hub. Clearing it returns control to the cascade. Always built-in — no configuration needed. |

**Important**: The cascade is not "pick the first layer that starts." It's "pick the first layer that *produces a topology.*" A layer can start successfully (e.g., broadcast self-test passes) but still not produce a topology yet (e.g., no other peers broadcasting). In that case, the `NetworkManager` keeps waiting for broadcast peers *and* simultaneously checks cloud and static — whichever produces a result first wins, with preference for higher-autonomy layers.

### How the Cascade Works at Runtime

The `NetworkManager` doesn't run layers sequentially and stop. All configured layers run **simultaneously** in the background. The cascade determines **which layer's result to use** when multiple layers have results:

1. **Broadcast is active and has peers?** → Use broadcast's election result. Ignore cloud and static.
2. **Broadcast is inactive or has no peers, but cloud has assigned a hub?** → Use cloud's assignment. Ignore static.
3. **Neither broadcast nor cloud produced a result, but static config exists?** → Use static's fixed hub.
4. **Manual override is set?** → Use it, regardless of what the cascade decided.

This means: if broadcast is working, adding a cloud config doesn't change anything — broadcast's result takes precedence. Cloud only matters when broadcast can't form a topology. And static only matters when *both* broadcast and cloud have failed.

**Re-evaluation is continuous**: If broadcast was blocked at startup but a network change makes it available later (e.g., VPN disconnects, firewall rule changes), the broadcast layer starts discovering peers. As soon as it forms a topology, the `NetworkManager` switches from cloud/static to broadcast — automatically upgrading to the more autonomous layer.

### The Discovery Layers in Detail

#### Try 1: UDP Broadcast — Zero-Config LAN Discovery

Each node periodically sends a UDP broadcast packet containing its `NodeInfo` (nodeId, hostname, IPs, domain, port). All nodes on the same local network receive it and build their peer tables.

```typescript
// Broadcast packet (JSON, ~200 bytes)
{
  "nodeId": "a1b2c3d4-...",
  "hostname": "WORKSTATION-7",
  "localIps": ["192.168.1.42"],
  "domain": "office-sync",
  "port": 3000,
  "startedAt": 1741123456789
}
```

**Self-test on startup**: The broadcast layer sends a packet to the broadcast address and listens for it. If it doesn't receive its own broadcast within 2 seconds, broadcast is blocked on this network — the layer reports `start() → false` and the `NetworkManager` knows to rely on fallback layers.

**Why broadcast fails** (and when the cascade kicks in):

| Scenario                         | What happens                                                   | Cascade falls to       |
| -------------------------------- | -------------------------------------------------------------- | ---------------------- |
| Corporate VLAN segmentation      | Broadcast stays within VLAN, nodes on other VLANs invisible    | Cloud or Static        |
| Firewall blocks UDP 41234        | Self-test fails, `start() → false`                             | Cloud or Static        |
| Nodes on different subnets/VPNs  | Broadcast doesn't cross subnet boundaries                      | Cloud or Static        |
| Single node on the network       | Broadcast works, but no peers respond                          | Waits, or Cloud/Static |
| Flat office LAN, no restrictions | **Works perfectly** — all nodes discover each other, elect hub | *(no fallback needed)* |

**Hub election**: When broadcast discovers peers, `HubElection.elect()` uses two rules to pick the hub:

1. **Incumbent advantage**: If there is already a hub and it's still reachable, keep it. This prevents unnecessary hub migrations when new nodes join.
2. **Earliest startup time**: If there is no incumbent (first boot or hub died), the node with the earliest `startedAt` timestamp wins. This is deterministic — all nodes compute the same result independently.

Why not "lowest UUID"? Random UUIDs have no meaningful ordering. A freshly started node could have a lower UUID than an established hub, causing a pointless migration. Startup time is a natural tiebreaker: the node that has been running longest is likely the most stable, and the result is stable — new nodes joining never displace the incumbent.

```typescript
function electHub(
  peers: NodeInfo[],
  currentHubId: string | null,
  probes: PeerProbe[],
  selfId: string,
): string | null {
  // Only consider reachable peers (or self)
  const reachable = peers.filter(
    (p) =>
      p.nodeId === selfId ||
      probes.some((pr) => pr.toNodeId === p.nodeId && pr.reachable),
  );

  if (reachable.length === 0) return null;

  // Rule 1: Incumbent stays if reachable
  if (currentHubId && reachable.some((p) => p.nodeId === currentHubId)) {
    return currentHubId;
  }

  // Rule 2: Earliest startedAt wins (tiebreaker: lexicographic nodeId)
  reachable.sort((a, b) => {
    const timeDiff = a.startedAt - b.startedAt;
    if (timeDiff !== 0) return timeDiff;
    return a.nodeId.localeCompare(b.nodeId);
  });

  return reachable[0].nodeId;
}
```

**Peer timeout**: If a peer misses 3 consecutive broadcast intervals (default: 3 × 5s = 15s), it's removed from the peer table. If the removed peer was the hub, re-election triggers immediately — Rule 1 no longer applies (incumbent is gone), so Rule 2 picks the longest-running survivor.

#### Try 2: Cloud Service — Cross-Network Fallback

The cloud is the **first fallback** when broadcast can't reach all peers. It bridges network boundaries that broadcast can't cross — different VLANs, subnets, VPNs, or even different physical locations.

The cloud is a **coordinator**, not a participant in data sync. It never sees application data, never relays sync messages, never stores files or blobs.

| Cloud does                               | Cloud does NOT             |
| ---------------------------------------- | -------------------------- |
| Registry: "these nodes share domain X"   | Relay sync data            |
| Distribute peer lists (local IPs)        | Measure LAN latency        |
| Aggregate probe reports from nodes       | Access files or databases  |
| Delegate roles: "node A, you're the hub" | Store any application data |
| Provide web dashboard / monitoring       |                            |
| Persist topology across restarts         |                            |

**The key insight**: The cloud can't measure LAN latency — it sits outside the network. But it can tell nodes to measure *each other* and report back. Nodes are the **sensors**, the cloud is the **brain**.

**Flow**:

1. Node starts → broadcast self-test fails → cloud layer activates
2. Node registers with cloud: *"I'm nodeX, IPs [192.168.1.42], domain 'office-sync'"*
3. Cloud responds: *"Your peers are nodeY@192.168.1.10, nodeZ@192.168.1.22"*
4. Node probes peers (TCP connect/disconnect, measures round-trip)
5. Node reports to cloud: *"nodeY: reachable, 0.3ms. nodeZ: unreachable."*
6. Cloud aggregates all reports, builds connectivity graph, assigns hub:
   *"nodeY is the hub — it's reachable by all peers with lowest average latency"*

The cloud layer **dictates** the hub (unlike broadcast, which uses local election). This is intentional — the cloud has the full picture across all nodes, including nodes on different subnets or VPNs, that no single node could see on its own.

**Why cloud fails** (and when the cascade falls further):

| Scenario                         | What happens                                     | Cascade falls to |
| -------------------------------- | ------------------------------------------------ | ---------------- |
| No cloud configured              | Cloud layer not started, `start() → false`       | Static           |
| Cloud endpoint unreachable       | Cloud layer polls, reports inactive              | Static           |
| Internet down                    | Cloud can't be reached                           | Static           |
| Cloud has no other peers yet     | Cloud returns empty peer list, no hub assignment | Waits, or Static |
| Air-gapped network (no internet) | Cloud impossible by design                       | Static           |

**When cloud activates alongside broadcast**: On a corporate network where some nodes are on the same VLAN (broadcast works between them) but other nodes are on a different VLAN (broadcast can't reach them), the cloud layer fills the gap. The `NetworkManager` merges peers from both layers — broadcast-discovered LAN peers and cloud-discovered remote peers — into a single peer table. The cloud's hub assignment takes precedence because it sees the full picture.

#### Try 3: Static Config — Hardcoded Last Resort

The last resort. A `hubAddress` in the config file tells the node exactly where to connect. No discovery, no election, no automation. This is what the *current* system does — just wrapped in the new abstraction.

```typescript
class StaticLayer implements DiscoveryLayer {
  readonly name = 'static';

  start(identity: NodeIdentity): Promise<boolean> {
    // If config.static.hubAddress is set, produce a peer for the hub
    // Return true if hubAddress was configured, false otherwise
  }

  getAssignedHub(): NodeId | null {
    // Static layer always dictates the hub (the configured address)
    return this._configuredHubNodeId;
  }
}
```

**When static config is the right choice**:

- Air-gapped networks with no internet (cloud impossible) and broadcast blocked (strict firewall)
- Development/testing environments where you want deterministic, predictable topology
- Transition period: existing deployments that haven't migrated to broadcast/cloud yet
- Emergency fallback: "everything automatic failed, here's the known-good hub IP"

**Static config is not a dead end**: Even when operating in static mode, the broadcast and cloud layers keep running in the background. If broadcast suddenly starts working (e.g., firewall rule removed) or the cloud comes online, the `NetworkManager` automatically upgrades to the more autonomous layer. Static config just prevents the system from being stuck in `unassigned` while waiting.

#### Override: Manual / UI — Human Intervention (always present)

The manual/UI override is **always available** — it requires no configuration and cannot be disabled. Unlike cloud and static, which are optional layers that must be explicitly configured, the manual override is a built-in part of every deployment. It is an escape hatch for when the automatic result is wrong and a human needs to intervene.

```typescript
class ManualLayer implements DiscoveryLayer {
  readonly name = 'manual';

  assignHub(nodeId: string): void {
    this._assignedHub = nodeId;
    this.emit('hub-assigned', nodeId);
  }

  clearOverride(): void {
    this._assignedHub = null;
    // System reverts to the automatic cascade's decision
  }
}
```

**When manual override is needed**:

- The automatic election picked a node that's about to go offline for maintenance
- A specific machine has better hardware (more RAM, faster disk) and *should* be the hub
- Debugging: force a specific topology to reproduce an issue
- Company policy: "machine X is always the server" (organizational override)

**Clearing the override** returns control to the automatic cascade. The `NetworkManager` re-evaluates broadcast → cloud → static and picks the best available result.

### Cascade Summary

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Autonomy Level                                    │
│                                                                          │
│  ████████████████████████████  Broadcast (Try 1)    always on            │
│  ██████████████████            Cloud     (Try 2)    optional, needs cfg  │
│  █████████                     Static    (Try 3)    optional, hardcoded  │
│                                                                          │
│  ──── Manual Override ────     at any time          always present       │
└──────────────────────────────────────────────────────────────────────────┘

The system always prefers the most autonomous layer that produces a result.
Less autonomous layers serve as fallbacks, not replacements.

Optional vs. required:
  • Broadcast  — always enabled by default. No configuration needed.
  • Cloud      — optional. Must be explicitly configured. Not present unless enabled.
  • Static     — optional. Only used when a hubAddress is set in the config file.
  • Manual/UI  — always present. Built into every deployment. Cannot be disabled.
```

### Peer Probing

Discovery (layers) answers: *"Who exists?"*
Probing answers: *"Can I actually reach them, and how fast?"*

These are separate concerns. A node discovered via cloud might be on a blocked port. A node discovered via broadcast might have 200ms latency due to network congestion.

```typescript
class PeerProber {
  // TCP connect probe: open socket, measure round-trip, close
  async probe(host: string, port: number, timeoutMs: number): Promise<PeerProbe> {
    const start = performance.now();
    try {
      const socket = net.createConnection({ host, port });
      await once(socket, 'connect');
      const latencyMs = performance.now() - start;
      socket.destroy();
      return { reachable: true, latencyMs, measuredAt: Date.now() };
    } catch {
      return { reachable: false, latencyMs: -1, measuredAt: Date.now() };
    }
  }
}
```

The `ProbeScheduler` runs probes periodically (default: every 10s) against all known peers and updates the probe results in the `PeerTable`. Hub election uses probe results to exclude unreachable peers — you can't be the hub if nobody can reach you.

### The NetworkManager

The central orchestrator. It:

1. Starts all configured discovery layers simultaneously
2. Merges peer tables from all layers into a unified `PeerTable`
3. Applies the fallback cascade: use the most autonomous layer's result that has produced a topology
4. Emits topology events when anything changes
5. Continuously re-evaluates: if a more autonomous layer starts producing results, upgrade to it

```typescript
class NetworkManager extends EventEmitter {
  constructor(config: NetworkConfig);

  start(): Promise<void>;
  stop(): Promise<void>;

  getTopology(): NetworkTopology;
  getIdentity(): NodeIdentity;

  // Manual override (exposed from ManualLayer)
  assignHub(nodeId: string): void;
  clearOverride(): void;

  // Events:
  // 'topology-changed'  → full NetworkTopology snapshot
  // 'role-changed'      → { previous: NodeRole, current: NodeRole }
  // 'hub-changed'       → { previousHub: string|null, currentHub: string }
  // 'peer-joined'       → NodeInfo
  // 'peer-left'         → string (nodeId)
}
```

### Hub Decision Logic

The `NetworkManager` evaluates hub assignment using the fallback cascade with manual override:

```
1. Manual override set?              → use it (human knows best)
2. Broadcast active and has peers?   → HubElection.elect(broadcastPeers) — incumbent + earliest startedAt
3. Cloud active and has assigned?    → use cloud's assignment — it sees the full picture
4. Static config has hubAddress?     → use static's fixed hub — last resort
5. Nothing?                          → myRole = 'unassigned', keep trying
```

This is the cascade in code:

```typescript
private computeHub(): string | null {
  // Override: manual always wins
  if (this.manualLayer.getAssignedHub()) {
    return this.manualLayer.getAssignedHub();
  }

  // Try 1: Broadcast — most autonomous
  if (this.broadcastLayer.isActive() && this.broadcastLayer.getPeers().length > 0) {
    return HubElection.elect(
      this.broadcastLayer.getPeers(),
      this.currentHubId,
      this.probeResults,
      this.identity.nodeId,
    );
  }

  // Try 2: Cloud — first fallback
  if (this.cloudLayer?.isActive() && this.cloudLayer.getAssignedHub()) {
    return this.cloudLayer.getAssignedHub();
  }

  // Try 3: Static — last resort
  if (this.staticLayer?.isActive() && this.staticLayer.getAssignedHub()) {
    return this.staticLayer.getAssignedHub();
  }

  // Nothing worked
  return null;
}
```

### Topology Data Model

All layers produce the same data structure:

```typescript
interface NodeInfo {
  nodeId: string;           // Persistent UUID, generated once, stored on disk
  hostname: string;         // Machine name (os.hostname())
  localIps: string[];       // All non-internal IPv4 addresses
  domain: string;           // Network domain — which group of nodes discover each other
  port: number;             // Port this node listens on when hub
  startedAt: number;        // Timestamp of node start
}

interface PeerProbe {
  fromNodeId: string;
  toNodeId: string;
  reachable: boolean;
  latencyMs: number;        // TCP round-trip, -1 if unreachable
  measuredAt: number;       // Timestamp of measurement
}

interface NetworkTopology {
  domain: string;
  hubNodeId: string | null;
  hubAddress: string | null;  // "ip:port" — ready to pass to Socket.IO
  formedBy: 'broadcast' | 'cloud' | 'manual' | 'static';
  formedAt: number;
  nodes: Map<string, NodeInfo>;
  probes: PeerProbe[];
  myRole: 'hub' | 'client' | 'unassigned';
}
```

The `formedBy` field tells you which layer produced the current topology — useful for logging, debugging, and understanding why a particular hub was chosen.

### Configuration

```typescript
interface NetworkConfig {
  domain: string;                     // Network domain — which group of nodes discover each other
  port: number;                       // Port this node listens on when hub
  identityDir?: string;               // Where to persist nodeId (default: ~/.sl-network/)

  // Try 3: Static — last resort fallback (optional)
  static?: {
    hubAddress?: string;              // "ip:port" — bypass all discovery
  };

  // Try 1: Broadcast — primary automatic discovery (enabled by default)
  broadcast?: {
    enabled: boolean;                 // default: true
    port: number;                     // UDP port for announcements (default: 41234)
    intervalMs?: number;              // How often to announce (default: 5000)
    timeoutMs?: number;               // Remove peer after N ms silence (default: 15000)
  };

  // Try 2: Cloud — first fallback (optional)
  cloud?: {
    enabled: boolean;                 // default: false (must be explicitly configured)
    endpoint: string;                 // Cloud service URL
    apiKey?: string;                  // Authentication
    pollIntervalMs?: number;          // How often to poll (default: 30000)
  };

  probing?: {
    enabled: boolean;
    intervalMs?: number;              // How often to probe all peers (default: 10000)
    timeoutMs?: number;               // Probe timeout (default: 2000)
  };

  // NOTE: Manual / UI override has NO config entry here.
  // It is always present, always available, and cannot be disabled.
  // It is accessed via ManualLayer.assignHub() / clearOverride() at runtime.
}
```

**Default behavior**: With an empty config (just `domain` and `port`), broadcast is enabled and cloud/static are off. The node tries to self-organize via LAN broadcast. If that fails and no fallback is configured, it stays `unassigned` until peers appear. This is the zero-config experience. The manual/UI override is always available regardless of configuration — a human can always step in and assign the hub via the dashboard.

---

## Integration with `@rljson/server`

### The Node Class — Where Network Meets Protocol

The `Node` class is the bridge between `@rljson/network` (topology) and `@rljson/server` (sync protocol). It lives in `@rljson/server` and orchestrates the lifecycle:

```
@rljson/server
│
├── Server          (existing — Socket.IO relay, multicast, bootstrap)
├── Client          (existing — IoMulti/BsMulti, Connector setup)
├── SocketIoBridge  (existing — Socket.IO ↔ Socket adapter)
│
└── Node            (NEW — self-organizing participant)
    │
    ├── uses NetworkManager from @rljson/network
    │   → fallback cascade, hub election, probing
    │
    ├── reacts to role-changed events
    │   → becomes Server or Client automatically
    │
    ├── manages Server/Client lifecycle
    │   → teardown + restart on hub migration
    │
    └── exposes topology to application
```

#### Role Transitions

When `NetworkManager` emits `role-changed`, the `Node` must:

**Becoming the Hub:**

1. Stop the current `Client` (if running): close Socket.IO connection, tear down `IoMulti`/`BsMulti`, stop `Connector`
2. Create HTTP + Socket.IO server on the configured port
3. Create `Server` with fresh `IoMem` + `BsMem` (server is stateless)
4. Emit `ready` so the application can set up FsAgent, E2E handlers, etc.

**Becoming a Client:**

1. Stop the current `Server` (if running): close HTTP server, tear down server-side `IoMulti`/`BsMulti`
2. Connect to the hub via Socket.IO using `hubAddress` from topology
3. Create `Client` with `SocketIoBridge`, local `IoMem` + `BsMem`
4. Call `client.init()` — sets up `IoMulti` (local + remote peer), creates `Db` + `Connector`
5. Emit `ready` so the application can set up FsAgent

**Why this works**: Because the `Server` is stateless (all data is in `IoMem`, no persistence), tearing it down loses nothing. The filesystem on each node is the durable store. When a new hub starts, clients reconnect and bootstrap — the protocol handles convergence automatically.

#### The Existing Server and Client Classes Don't Change

This is critical. `Server` and `Client` in `@rljson/server` remain exactly as they are:

- `Server` still takes a `Route`, `Io`, `Bs`, and `ServerOptions`
- `Server.addSocket()` still creates peers, rebuilds multis, installs multicast, sends bootstrap
- `Client` still takes a `SocketLike`, `Io`, `Bs`, optional `Route`, and `ClientOptions`
- `Client.init()` still sets up `IoMulti`/`BsMulti`, creates `Db`/`Connector`

The `Node` class simply calls these constructors and methods at the right time, based on topology events. No refactoring of the sync protocol required.

#### The `domain` ↔ `treeKey` Mapping

The network layer uses `domain` — a name that groups nodes which should discover each other. The RLJSON sync layer uses `treeKey` — the database table where tree data is stored. These are separate concepts at separate layers:

- **`domain`** (`@rljson/network`): "Which nodes form a network together?" — used for broadcast filtering, cloud registration, peer grouping. The network layer knows nothing about trees or databases.
- **`treeKey`** (`@rljson/server`, `@rljson/fs-agent`): "Where in the database are the trees stored?" — used for `Route`, `Db`, `Connector`, `FsAgent`.

The `Node` class bridges both: it passes `domain` to the `NetworkManager` and `treeKey` to the `Server`/`Client`/`FsAgent` constructors. In many deployments, both will have the same value (e.g., `domain: 'projectFiles'`, `treeKey: 'projectFilesTree'`), but they don't have to — the network grouping is independent of the database schema.

### How FsAgent Plugs In

`@rljson/fs-agent` already has `FsAgent.fromClient()` — a factory method that creates a fully wired agent from a `Client` instance:

```typescript
const agent = await FsAgent.fromClient(
  folderPath,     // directory to sync
  treeKey,        // database table for tree storage (RLJSON concept, mapped from network domain)
  client,         // Client from @rljson/server
  socket,         // Socket for Connector
  { ignore: ['node_modules', '.git'] }
);

// Start bidirectional sync
const stopToDb = await agent.syncToDbSimple({ notify: true });
const stopFromDb = await agent.syncFromDbSimple({ cleanTarget: true });
```

With the `Node` class, this wiring happens automatically on every role transition. The `Node` emits a `ready` event with the active `Client` (or `Server`), and the application creates the FsAgent.

### Hub Migration Timeline

Here's what happens when the hub dies and re-election occurs:

```
t=0s    Hub (node A) crashes
t=5s    Broadcast: nodes B, C miss node A's announcement
t=10s   Broadcast: still no node A
t=15s   Broadcast timeout: node A removed from peer tables
        HubElection: no incumbent reachable → node B has earliest startedAt → elected hub
        NetworkManager emits 'role-changed' on all surviving nodes

t=15s   Node B: role → 'hub'
        - tears down Client (closes socket)
        - starts HTTP + Socket.IO server on port 3000
        - creates Server with fresh IoMem/BsMem
        - emits 'ready'

t=15s   Node C: role → 'client', hubAddress → 'nodeB-ip:3000'
        - tears down old Client (stale connection to dead hub)
        - creates new Socket.IO connection to node B
        - creates Client + init()
        - Client sends bootstrap request
        - Connector receives bootstrap ref from new hub
        - FsAgent.syncFromDb() converges state
        - emits 'ready'

t=16s   System converged. All nodes syncing through new hub (node B).
```

**Total downtime: ~16 seconds** from hub crash to full convergence. All data preserved — nothing was lost because the filesystem is the source of truth.

---

## Integration with `ds_serverless_client_server`

### Before (Current Architecture)

The application has separate entry points for server and client, with role hardcoded in config:

```typescript
// sl-server.ts — runs on the designated server machine
export const startServer = async (args) => {
  const config = readConfig(configPath, defaultServerConfig());
  const route = Route.fromFlat(`/${config.treeKey}`);
  const serverIo = new IoMem();
  const rljsonServer = new Server(route, serverIo, serverBs, options);
  // ... HTTP endpoints, Socket.IO setup
};

// sl-client.ts — runs on client machines, serverUrl hardcoded
export const startClient = async (args) => {
  const config = readConfig(configPath, defaultClientConfig());
  const socket = SocketIoClient(config.serverUrl);  // ← hardcoded address
  const client = new Client(bridge, localIo, localBs, undefined, options);
  const agent = await FsAgent.fromClient(config.folder, config.treeKey, client, bridge);
  // ... start sync
};
```

Two separate executables. Two separate configs. Manual role assignment.

### After (Self-Organizing Architecture)

One entry point. One config. Automatic role discovery:

```typescript
// sl-node.ts — runs on every machine
export const startNode = async (args) => {
  const config = readConfig(configPath, defaultNodeConfig());

  const node = new Node({
    treeKey: config.treeKey,   // RLJSON concept: database table for tree storage
    domain: config.domain,     // Network concept: which nodes discover each other
    folder: config.folder,
    port: config.port,
    ignore: config.ignore,
    cleanTarget: config.cleanTarget,
    network: {
      // Try 1: Broadcast is enabled by default — zero config needed
      broadcast: { enabled: true, port: 41234 },
      // Try 2: Cloud fallback — only if configured
      cloud: config.cloud,
      // Try 3: Static last resort — only if configured
      static: config.static,
    },
  });

  node.on('ready', ({ role, client, server }) => {
    // Optional: set up E2E test handlers, logging, health endpoints
  });

  node.on('topology-changed', (topology) => {
    console.log(`Topology formed by: ${topology.formedBy}`);
    // 'broadcast' = best case, zero-config LAN
    // 'cloud'     = fallback, cross-network
    // 'static'    = last resort, hardcoded
    // 'manual'    = human override
  });

  await node.start();
  // Done. Node self-organizes, syncs files, re-elects on failures.
};
```

The `startServer()` and `startClient()` functions aren't deleted — they become internal implementation details that `Node` calls when transitioning roles.

---

## The Dependency Graph

```
Layer 0:  @rljson/rljson          (no @rljson deps)
Layer 0:  @rljson/network         (no @rljson deps)
Layer 1:  @rljson/io              (depends on rljson)
Layer 2:  @rljson/bs              (depends on rljson, io)
Layer 2:  @rljson/db              (depends on rljson, io)
Layer 3:  @rljson/server          (depends on rljson, io, bs, db, network)
Layer 4:  @rljson/fs-agent        (depends on server + everything below)

Application: ds_serverless_client_server
             (depends on @rljson/fs-agent — network comes transitively)
```

`@rljson/network` sits at Layer 0, parallel to `@rljson/rljson`. They don't know about each other. This means `@rljson/network` is fully reusable — a chat app, a game lobby, an IoT mesh, or any system that needs self-organizing star topology can use it without pulling in the RLJSON data model.

### Publish Order

| Order | Package            | Depends on                                              |
| ----- | ------------------ | ------------------------------------------------------- |
| 1     | `@rljson/rljson`   | —                                                       |
| 1     | `@rljson/network`  | — (publishable in parallel with rljson)                 |
| 2     | `@rljson/io`       | rljson                                                  |
| 3     | `@rljson/bs`       | rljson, io                                              |
| 3     | `@rljson/db`       | rljson, io                                              |
| 4     | `@rljson/server`   | rljson, io, bs, db, **network**                         |
| 5     | `@rljson/fs-agent` | rljson, io, bs, db, server (network comes transitively) |

---

## Module Structure of `@rljson/network`

```
rljson-network/
├── src/
│   ├── types/
│   │   ├── node-info.ts            // NodeInfo, NodeId
│   │   ├── peer-probe.ts           // PeerProbe
│   │   ├── network-topology.ts     // NetworkTopology, NodeRole
│   │   ├── network-config.ts       // NetworkConfig (all layer configs)
│   │   └── network-events.ts       // Event type definitions
│   ├── identity/
│   │   └── node-identity.ts        // Persistent UUID, hostname, IP discovery
│   ├── layers/
│   │   ├── discovery-layer.ts      // Interface: what every layer must implement
│   │   ├── broadcast-layer.ts      // Try 1: UDP announce/listen (primary)
│   │   ├── cloud-layer.ts          // Try 2: REST API to cloud service (first fallback)
│   │   ├── static-layer.ts         // Try 3: reads hubAddress from config (last resort)
│   │   └── manual-layer.ts         // Override: programmatic override API
│   ├── probing/
│   │   ├── peer-prober.ts          // Single TCP probe
│   │   └── probe-scheduler.ts      // Periodic probing of all known peers
│   ├── election/
│   │   └── hub-election.ts         // Incumbent advantage + earliest startedAt election
│   ├── peer-table.ts               // Merged view of all peers from all layers
│   ├── network-manager.ts          // Main orchestrator: cascade + events
│   └── index.ts                    // Public API exports
├── test/
│   ├── layers/
│   │   ├── broadcast-layer.spec.ts
│   │   ├── cloud-layer.spec.ts
│   │   ├── static-layer.spec.ts
│   │   └── manual-layer.spec.ts
│   ├── probing/
│   │   └── peer-prober.spec.ts
│   ├── election/
│   │   └── hub-election.spec.ts
│   ├── peer-table.spec.ts
│   └── network-manager.spec.ts
```

---

## Edge Cases and Design Decisions

### What Happens When Two Nodes Start Simultaneously?

Both broadcast, both build peer tables, both run the same election algorithm. Since neither is an incumbent hub yet, Rule 2 applies: the node with the earlier `startedAt` timestamp wins. If they started at exactly the same millisecond (astronomically unlikely), the lexicographic nodeId tiebreaker ensures a deterministic result. One becomes hub, the other becomes client. No race condition — the election doesn't require coordination.

### What Happens During a Network Partition?

If the LAN splits (rare, but possible), each fragment independently forms its own star. Each fragment's nodes see only each other on their local network segment and elect their own hub (each fragment's incumbent or earliest startedAt). When the partition heals, the fragments discover each other via broadcast and peer tables merge. If both fragments had incumbent hubs, the one with the earlier `startedAt` wins (Rule 1 can't apply since neither incumbent was visible to the other fragment, so Rule 2 breaks the tie). The RLJSON data model handles the data merge naturally — content-addressed data deduplicates automatically, and insert histories are append-only.

### What If Broadcast Is Blocked?

The broadcast layer self-tests on startup. If the node doesn't receive its own broadcast within 2 seconds, it reports `start() → false`. The `NetworkManager` notes that broadcast (Try 1) is unavailable and evaluates the next level of the cascade: cloud (Try 2), then static (Try 3).

### What If the Cloud Is Down?

The cloud layer polls periodically. If the endpoint is unreachable, it reports inactive. The cascade falls through to static config (Try 3). If static isn't configured either, the node stays `unassigned`. Meanwhile, all layers keep retrying in the background — if cloud comes back online, the `NetworkManager` upgrades to it automatically.

### What If No Layer Produces a Hub?

The node stays in `myRole = 'unassigned'`. It keeps broadcasting, keeps polling the cloud, keeps checking its static config. As soon as any layer produces a peer and a hub decision, the node assumes its role. The cascade keeps running continuously — it's not a one-shot check.

### What If a Better Layer Becomes Available Later?

The `NetworkManager` continuously re-evaluates. Example scenario:

1. Node starts on a restrictive network. Broadcast fails (self-test). Cloud not configured. Static config points to `192.168.1.100:3000`. → Topology formed by static.
2. Admin enables cloud config and restarts the cloud service. Cloud layer starts polling, discovers peers, assigns hub. → Topology automatically upgrades from `formedBy: 'static'` to `formedBy: 'cloud'`.
3. Network firewall rules change, broadcast starts working. Broadcast discovers LAN peers. → Topology automatically upgrades from `formedBy: 'cloud'` to `formedBy: 'broadcast'`.

Each upgrade is seamless — the `Node` class handles the role transition (teardown old server/client, create new one) just like during hub migration.

### What About Security?

This document focuses on topology formation, not transport security. However:

- **Broadcast**: Unencrypted by design (LAN-local, no sensitive data in packets — just nodeId, hostname, domain)
- **Cloud**: HTTPS + API key authentication
- **Socket.IO connections**: Can use WSS (WebSocket Secure) — this is configured in the application, not in the network layer

---

## Development Strategy — Build Order

| Step | Package           | Component                    | What it proves                                                  |
| ---- | ----------------- | ---------------------------- | --------------------------------------------------------------- |
| 1    | `@rljson/network` | Types + NodeIdentity         | Data model compiles, UUID persistence works                     |
| 2    | `@rljson/network` | StaticLayer + NetworkManager | Simplest fallback layer works end-to-end (Try 3 path)           |
| 3    | `@rljson/network` | PeerProber + HubElection     | TCP probing works, election is deterministic                    |
| 4    | `@rljson/network` | BroadcastLayer               | Primary discovery works on local machine (Try 1 path)           |
| 5    | `@rljson/network` | Full cascade                 | Broadcast → fallback to Static works, upgrade back to Broadcast |
| 6    | `@rljson/server`  | Node class                   | Role transitions work: hub → client → hub                       |
| 7    | Integration       | ds_serverless_client_server  | Full application with self-organizing nodes                     |
| 8    | `@rljson/network` | CloudLayer                   | Cloud fallback works (Try 2 path), cascade complete             |
| 9    | Cloud service     | Backend                      | Cloud coordination service                                      |
| 10   | UI                | Dashboard                    | Topology visualization and manual override                      |

Each step is independently testable. Each step produces a working system — just with fewer cascade levels. Step 2 already replaces the current hardcoded `serverUrl` approach with the new abstraction. Step 4 adds zero-config LAN discovery. Step 8 completes the full three-level cascade.

---

## Summary

The RLJSON ecosystem was built with decentralized data at its core — content-addressed, immutable, conflict-free. But the network layer that moves this data between machines has been centralized: fixed roles, hardcoded IPs, manual configuration.

`@rljson/network` closes this gap. It brings the same philosophy to network formation: no pre-assigned roles, no hardcoded configuration, automatic discovery and self-organization. And it does this without changing a single line in the sync protocol — the star topology stays, the data flow stays, the bootstrap protocol stays. Only the decision of *who is the hub* moves from a config file to an automatic, layered discovery system.

The fallback cascade ensures the system always finds a way to form a topology:

1. **Broadcast** — zero-config, fully automatic, works out of the box on any flat LAN
2. **Cloud** — bridges network boundaries when broadcast can't, automatic but requires configuration
3. **Static** — hardcoded fallback, always works, the current system wrapped in the new abstraction
4. **Manual override** — human escape hatch, orthogonal to the cascade

The result: drop identical software on N machines, give them a `domain` and a folder path, and they form a network. One becomes the hub, the rest become clients. When the hub goes down, they re-elect. When a new machine joins, it's discovered automatically. When nothing works automatically, there's always the config file.

**Decentralized data deserves a decentralized network.**

---

## Implementation Roadmap — Scrum Tickets

### Epic 1: Foundation — Types & Identity

#### 1.1 Define core type interfaces

Create the type definitions that all subsequent work depends on.

- `NodeInfo` (nodeId, hostname, localIps, domain, port, startedAt)
- `NodeId` type alias
- `PeerProbe` (fromNodeId, toNodeId, reachable, latencyMs, measuredAt)
- `NetworkTopology` (domain, hubNodeId, hubAddress, formedBy, formedAt, nodes, probes, myRole)
- `NodeRole` type: `'hub' | 'client' | 'unassigned'`
- `NetworkConfig` (domain, port, identityDir, broadcast/cloud/static sub-configs, probing)
- `NetworkEvents` (topology-changed, role-changed, hub-changed, peer-joined, peer-left)

**AC**: Types compile, are exported from `index.ts`, 100% coverage.

#### 1.2 Implement NodeIdentity

Persistent UUID generation + storage, hostname resolution, local IP discovery.

- Generate UUID v4 on first run, persist to `~/.sl-network/<domain>/node-id`
- Read from disk on subsequent runs (same machine = same identity)
- Expose `hostname` via `os.hostname()`
- Expose `localIps` (all non-internal IPv4 addresses)
- Expose `startedAt` (set once at construction time)

**AC**: NodeIdentity persists across restarts, discovers correct IPs, 100% coverage.

---

### Epic 2: Static Layer + NetworkManager Shell

#### 2.1 Define DiscoveryLayer interface

The contract all layers implement: `start()`, `stop()`, `isActive()`, `getPeers()`, `getAssignedHub()`, events (`peer-discovered`, `peer-lost`, `hub-assigned`).

**AC**: Interface exported, no implementation yet.

#### 2.2 Implement ManualLayer

Always-present override layer. `assignHub(nodeId)`, `clearOverride()`. Cannot be disabled.

**AC**: ManualLayer passes hub-assigned events, clearOverride reverts to null, 100% coverage.

#### 2.3 Implement StaticLayer

Reads `hubAddress` from config. If set → produces a synthetic peer for the hub and returns it as assigned hub. If not set → `start()` returns false.

**AC**: StaticLayer returns configured hub, returns false when no config, 100% coverage.

#### 2.4 Implement PeerTable

Merges peers from all layers into a deduplicated map by nodeId. Emits `peer-joined`/`peer-left` when the merged set changes.

**AC**: Merges from multiple sources, deduplicates, emits events, 100% coverage.

#### 2.5 Implement NetworkManager (minimal)

Orchestrator shell: starts layers, merges peer tables, applies cascade logic (`computeHub()`), emits topology events. Initially only supports ManualLayer + StaticLayer.

**AC**: `start()`/`stop()` lifecycle works, `computeHub()` correctly applies manual > static priority, `getTopology()` returns correct snapshot, `assignHub()`/`clearOverride()` work, 100% coverage.

#### 2.6 End-to-end test: Static path

One node starts with `static.hubAddress` configured → becomes client, topology `formedBy: 'static'`. Manual override supersedes. Clearing override reverts to static.

**AC**: Full cascade for Try 3 + Override path works.

---

### Epic 3: Hub Election + Probing

#### 3.1 Implement HubElection

`electHub(peers, currentHubId, probes, selfId)` — deterministic election:

1. Filter to reachable peers only
2. Incumbent advantage (if current hub is reachable, keep it)
3. Earliest `startedAt` wins
4. Lexicographic nodeId tiebreaker

**AC**: All election rules tested — incumbent stays, earliest wins, tiebreaker works, unreachable peers excluded, 100% coverage.

#### 3.2 Implement PeerProber

Single TCP connect probe: open socket → measure round-trip → close. Returns `PeerProbe` with `reachable`, `latencyMs`, `measuredAt`.

**AC**: Probes reachable host, handles unreachable/timeout, 100% coverage.

#### 3.3 Implement ProbeScheduler

Periodic probing of all known peers. Configurable interval (default 10s) and timeout (default 2s). Updates probe results in PeerTable.

**AC**: Probes run on schedule, results stored, stale probes cleaned up, 100% coverage.

#### 3.4 Wire probing into NetworkManager

NetworkManager starts ProbeScheduler, passes probe results to HubElection. Hub election re-runs when probe results change.

**AC**: Unreachable hub triggers re-election, newly reachable peer joins candidate pool.

---

### Epic 4: Broadcast Layer (Primary Discovery)

#### 4.1 Implement BroadcastLayer — sending

UDP broadcast of `NodeInfo` JSON packet (~200 bytes) on configurable port (default 41234) at configurable interval (default 5s). Only broadcasts to nodes in same `domain`.

**AC**: Packets sent at interval, contain correct NodeInfo, filtered by domain.

#### 4.2 Implement BroadcastLayer — receiving

Listen for UDP broadcast packets. Parse, validate domain match, add to peer table. Emit `peer-discovered`.

**AC**: Receives peers, filters by domain, adds to peer list, 100% coverage.

#### 4.3 Implement BroadcastLayer — self-test

On startup, send broadcast and listen for own packet. If not received within 2s → `start()` returns false (broadcast blocked on this network).

**AC**: Self-test passes on loopback, self-test timeout correctly reports false.

#### 4.4 Implement BroadcastLayer — peer timeout

If a peer misses 3 consecutive broadcast intervals (default 15s) → remove from peer table. Emit `peer-lost`. If removed peer was hub → trigger re-election.

**AC**: Stale peers removed, hub loss triggers re-election, 100% coverage.

#### 4.5 Wire BroadcastLayer into NetworkManager cascade

Broadcast (Try 1) takes priority over Static (Try 3). When broadcast has peers → use broadcast election. When broadcast has no peers → fall through to static.

**AC**: Cascade priority correct. Broadcast supersedes static when active. Falls back when broadcast inactive.

#### 4.6 End-to-end test: Broadcast path

Two nodes on same machine (different ports) → discover via broadcast → elect hub → form topology `formedBy: 'broadcast'`. Kill hub → re-election → new hub.

**AC**: Full Try 1 path works including re-election.

#### 4.7 End-to-end test: Broadcast → Static fallback

Broadcast self-test fails (simulated) → falls to static config → topology `formedBy: 'static'`. Broadcast becomes available → auto-upgrade to `formedBy: 'broadcast'`.

**AC**: Fallback and auto-upgrade both work.

---

### Epic 5: Node class in `@rljson/server`

#### 5.1 Implement Node class — lifecycle

New class in `@rljson/server`. Takes `NodeConfig` (treeKey, domain, folder, port, network config). Creates `NetworkManager`, reacts to `role-changed`.

**AC**: Node starts NetworkManager, emits events, 100% coverage.

#### 5.2 Implement Node — becoming hub

On `role-changed` to `'hub'`: tear down Client (if running), create HTTP + Socket.IO server, create `Server` with fresh `IoMem`/`BsMem`, emit `ready`.

**AC**: Role transition hub path works, server accepts connections.

#### 5.3 Implement Node — becoming client

On `role-changed` to `'client'`: tear down Server (if running), connect Socket.IO to `hubAddress`, create `Client` + `SocketIoBridge` + `init()`, emit `ready`.

**AC**: Role transition client path works, client syncs with hub.

#### 5.4 Implement Node — hub migration

Full cycle: hub dies → re-election → surviving node becomes new hub → other nodes reconnect as clients → bootstrap → data converges.

**AC**: <16s convergence time, no data loss, all nodes synced after migration.

#### 5.5 Wire FsAgent into Node

On `ready`, create `FsAgent.fromClient()` (when client) or set up server-side FsAgent. Bidirectional sync with `syncToDbSimple`/`syncFromDbSimple`.

**AC**: File changes propagate through hub migration.

---

### Epic 6: Integration with `ds_serverless_client_server`

#### 6.1 Create unified `sl-node` entry point

Replace separate `sl-server` + `sl-client` with single `sl-node` that uses `Node` class. One config, one executable, automatic role discovery.

**AC**: `sl-node` starts, self-organizes, syncs files — replaces both old entry points.

#### 6.2 Update config schema

Merge `ServerConfig` + `ClientConfig` into `NodeConfig`. Add network section (broadcast, cloud, static). Remove `serverUrl` / `role` fields.

**AC**: Old configs migrated, new config documented.

#### 6.3 E2E tests with self-organizing nodes

Adapt existing E2E test suite to work with `Node` instead of separate server/client. Add hub-migration E2E test.

**AC**: Existing E2E tests pass with new architecture, hub migration test added.

---

### Epic 7: Cloud Layer (Cross-Network Fallback)

#### 7.1 Implement CloudLayer — client side

REST client that registers with cloud endpoint, polls for peer list, reports probe results. Respects cloud's hub assignment.

**AC**: Registration, polling, reporting all work, 100% coverage.

#### 7.2 Wire CloudLayer into NetworkManager cascade

Cloud (Try 2) sits between Broadcast (Try 1) and Static (Try 3). When broadcast has no peers but cloud assigns hub → use cloud. Auto-upgrade to broadcast when it becomes available.

**AC**: Full 3-level cascade: broadcast > cloud > static.

#### 7.3 Implement cloud coordination service (backend)

REST API: node registration, peer list distribution, probe aggregation, hub assignment. Persists topology across restarts.

**AC**: Cloud service runs, manages domains, assigns hubs based on probe reports.

#### 7.4 End-to-end test: Cloud path

Broadcast blocked (simulated) → cloud assigns hub → topology `formedBy: 'cloud'`. Broadcast enabled → auto-upgrade to `formedBy: 'broadcast'`.

**AC**: Full Try 2 path works including upgrade.

---

### Epic 8: Dashboard & Manual Override UI

#### 8.1 Topology visualization

Web dashboard showing all nodes, their roles, connections, probe latencies, which cascade layer formed the topology.

**AC**: Dashboard renders live topology, updates on changes.

#### 8.2 Manual override controls

UI button to force a specific node as hub. Clear-override button to return to automatic cascade.

**AC**: Override from UI propagates to ManualLayer, topology updates, clearing works.

---

### Recommended Sprint Grouping

| Sprint | Epics | Focus                                                           |
| ------ | ----- | --------------------------------------------------------------- |
| 1      | 1 + 2 | Foundation: types, identity, static layer, NetworkManager shell |
| 2      | 3     | Probing + hub election                                          |
| 3      | 4     | Broadcast layer (primary zero-config discovery)                 |
| 4      | 5     | Node class in `@rljson/server` (role transitions)               |
| 5      | 6     | Integration with `ds_serverless_client_server`                  |
| 6      | 7     | Cloud layer (cross-network fallback)                            |
| 7      | 8     | Dashboard & manual override UI                                  |

Epics 1–4 are pure `@rljson/network`. Epics 5–6 bridge to the application. Epics 7–8 extend the system.
