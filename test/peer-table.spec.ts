// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, beforeEach } from 'vitest';

import { PeerTable } from '../src/peer-table';
import { ManualLayer } from '../src/layers/manual-layer';
import { StaticLayer } from '../src/layers/static-layer';
import { NodeIdentity } from '../src/identity/node-identity';
import type { NodeInfo } from '../src/types/node-info';
import type {
  DiscoveryLayer,
  DiscoveryLayerEventName,
  DiscoveryLayerEvents,
} from '../src/layers/discovery-layer';

// .............................................................................

/** Create a minimal NodeIdentity for testing */
function testIdentity(): NodeIdentity {
  return new NodeIdentity({
    nodeId: 'self-node',
    hostname: 'test-host',
    localIps: ['10.0.0.1'],
    domain: 'test',
    port: 3000,
    startedAt: 1700000000000,
  });
}

/** Create a test NodeInfo */
function testPeer(id: string, ip = '10.0.0.' + id.slice(-1)): NodeInfo {
  return {
    nodeId: id,
    hostname: `host-${id}`,
    localIps: [ip],
    domain: 'test',
    port: 3000,
    startedAt: 1700000000000,
  };
}

// .............................................................................

/**
 * A minimal mock discovery layer for testing PeerTable.
 * Supports emitting events and returning pre-set peers.
 */
class MockLayer implements DiscoveryLayer {
  readonly name: string;
  private _active = false;
  private _peers: NodeInfo[] = [];
  private _assignedHub: string | null = null;
  private _listeners = new Map<
    string,
    Set<DiscoveryLayerEvents[DiscoveryLayerEventName]>
  >();

  constructor(name: string) {
    this.name = name;
  }

  async start(): Promise<boolean> {
    this._active = true;
    return true;
  }

  async stop(): Promise<void> {
    this._active = false;
  }

  isActive(): boolean {
    return this._active;
  }

  getPeers(): NodeInfo[] {
    return [...this._peers];
  }

  getAssignedHub(): string | null {
    return this._assignedHub;
  }

  on<E extends DiscoveryLayerEventName>(
    event: E,
    cb: DiscoveryLayerEvents[E],
  ): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb);
  }

  off<E extends DiscoveryLayerEventName>(
    event: E,
    cb: DiscoveryLayerEvents[E],
  ): void {
    this._listeners.get(event)?.delete(cb);
  }

  // --- Test helpers ---

  /** Add a peer and emit peer-discovered */
  addPeer(peer: NodeInfo): void {
    this._peers.push(peer);
    this._emit('peer-discovered', peer);
  }

  /** Remove a peer and emit peer-lost */
  removePeer(nodeId: string): void {
    this._peers = this._peers.filter((p) => p.nodeId !== nodeId);
    this._emit('peer-lost', nodeId);
  }

  /** Set pre-existing peers (before attachLayer imports them) */
  setInitialPeers(peers: NodeInfo[]): void {
    this._peers = [...peers];
  }

  private _emit<E extends DiscoveryLayerEventName>(
    event: E,
    ...args: Parameters<DiscoveryLayerEvents[E]>
  ): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}

// .............................................................................

describe('PeerTable', () => {
  let table: PeerTable;

  beforeEach(() => {
    table = new PeerTable();
    table.setSelfId('self-node');
  });

  // .........................................................................
  // Basic operations
  // .........................................................................

  it('starts empty', () => {
    expect(table.getPeers()).toEqual([]);
    expect(table.size).toBe(0);
  });

  it('getPeer returns undefined for unknown nodeId', () => {
    expect(table.getPeer('nonexistent')).toBeUndefined();
  });

  // .........................................................................
  // attachLayer — import existing peers
  // .........................................................................

  describe('attachLayer', () => {
    it('imports existing peers from a layer', () => {
      const layer = new MockLayer('layer-a');
      layer.setInitialPeers([testPeer('node-1'), testPeer('node-2')]);

      table.attachLayer(layer);

      expect(table.size).toBe(2);
      expect(table.getPeer('node-1')).toBeDefined();
      expect(table.getPeer('node-2')).toBeDefined();
    });

    it('excludes self from imported peers', () => {
      const layer = new MockLayer('layer-a');
      layer.setInitialPeers([testPeer('self-node'), testPeer('other-node')]);

      table.attachLayer(layer);

      expect(table.size).toBe(1);
      expect(table.getPeer('self-node')).toBeUndefined();
      expect(table.getPeer('other-node')).toBeDefined();
    });

    it('emits peer-joined for imported peers', () => {
      const layer = new MockLayer('layer-a');
      layer.setInitialPeers([testPeer('node-1')]);

      const joined: string[] = [];
      table.on('peer-joined', (peer) => joined.push(peer.nodeId));

      table.attachLayer(layer);
      expect(joined).toEqual(['node-1']);
    });

    it('handles attaching the same layer name twice', () => {
      const layer1 = new MockLayer('layer-a');
      layer1.setInitialPeers([testPeer('node-1')]);
      table.attachLayer(layer1);

      const layer2 = new MockLayer('layer-a');
      layer2.setInitialPeers([testPeer('node-2')]);
      table.attachLayer(layer2);

      expect(table.size).toBe(2);
    });
  });

  // .........................................................................
  // Dynamic peer discovery via events
  // .........................................................................

  describe('peer-discovered events', () => {
    it('adds peers discovered after attachment', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      layer.addPeer(testPeer('node-1'));
      expect(table.size).toBe(1);
      expect(table.getPeer('node-1')!.hostname).toBe('host-node-1');
    });

    it('emits peer-joined for new peers', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      const joined: string[] = [];
      table.on('peer-joined', (peer) => joined.push(peer.nodeId));

      layer.addPeer(testPeer('node-1'));
      expect(joined).toEqual(['node-1']);
    });

    it('does not emit peer-joined for duplicate peers', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      const joined: string[] = [];
      table.on('peer-joined', (peer) => joined.push(peer.nodeId));

      layer.addPeer(testPeer('node-1'));
      layer.addPeer(testPeer('node-1')); // duplicate
      expect(joined).toEqual(['node-1']); // only once
    });

    it('updates peer info on re-discovery', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      layer.addPeer(testPeer('node-1', '10.0.0.1'));
      expect(table.getPeer('node-1')!.localIps).toEqual(['10.0.0.1']);

      layer.addPeer(testPeer('node-1', '10.0.0.99'));
      expect(table.getPeer('node-1')!.localIps).toEqual(['10.0.0.99']);
    });

    it('excludes self from dynamically discovered peers', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      layer.addPeer(testPeer('self-node'));
      expect(table.size).toBe(0);
    });
  });

  // .........................................................................
  // Peer removal
  // .........................................................................

  describe('peer-lost events', () => {
    it('removes peer and emits peer-left', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);
      layer.addPeer(testPeer('node-1'));

      const left: string[] = [];
      table.on('peer-left', (id) => left.push(id));

      layer.removePeer('node-1');
      expect(table.size).toBe(0);
      expect(left).toEqual(['node-1']);
    });

    it('does not emit peer-left for unknown peer', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      const left: string[] = [];
      table.on('peer-left', (id) => left.push(id));

      layer.removePeer('nonexistent');
      expect(left).toEqual([]);
    });
  });

  // .........................................................................
  // Multi-layer deduplication
  // .........................................................................

  describe('multi-layer deduplication', () => {
    it('same peer from two layers appears once', () => {
      const layerA = new MockLayer('layer-a');
      const layerB = new MockLayer('layer-b');
      table.attachLayer(layerA);
      table.attachLayer(layerB);

      const joined: string[] = [];
      table.on('peer-joined', (peer) => joined.push(peer.nodeId));

      layerA.addPeer(testPeer('node-1'));
      layerB.addPeer(testPeer('node-1'));

      expect(table.size).toBe(1); // deduplicated
      expect(joined).toEqual(['node-1']); // joined only once
    });

    it('peer-left only fires when ALL layers lose the peer', () => {
      const layerA = new MockLayer('layer-a');
      const layerB = new MockLayer('layer-b');
      table.attachLayer(layerA);
      table.attachLayer(layerB);

      layerA.addPeer(testPeer('node-1'));
      layerB.addPeer(testPeer('node-1'));

      const left: string[] = [];
      table.on('peer-left', (id) => left.push(id));

      // Remove from layer A — layer B still has it
      layerA.removePeer('node-1');
      expect(table.size).toBe(1); // still known
      expect(left).toEqual([]); // not emitted

      // Remove from layer B — now truly gone
      layerB.removePeer('node-1');
      expect(table.size).toBe(0);
      expect(left).toEqual(['node-1']);
    });

    it('merges peers from different layers', () => {
      const layerA = new MockLayer('layer-a');
      const layerB = new MockLayer('layer-b');
      table.attachLayer(layerA);
      table.attachLayer(layerB);

      layerA.addPeer(testPeer('node-1'));
      layerB.addPeer(testPeer('node-2'));

      expect(table.size).toBe(2);
      expect(table.getPeer('node-1')).toBeDefined();
      expect(table.getPeer('node-2')).toBeDefined();
    });
  });

  // .........................................................................
  // Integration with real layers
  // .........................................................................

  describe('integration with real layers', () => {
    it('works with StaticLayer', async () => {
      const staticLayer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      table.attachLayer(staticLayer);

      await staticLayer.start(testIdentity());

      expect(table.size).toBe(1);
      const peer = table.getPeers()[0]!;
      expect(peer.nodeId).toBe('static-hub-10.0.0.1:3000');
    });

    it('works with ManualLayer (no peers added)', async () => {
      const manual = new ManualLayer();
      table.attachLayer(manual);

      await manual.start(testIdentity());
      expect(table.size).toBe(0); // manual never discovers peers
    });
  });

  // .........................................................................
  // clear
  // .........................................................................

  describe('clear', () => {
    it('removes all peers and layer tracking', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);
      layer.addPeer(testPeer('node-1'));

      expect(table.size).toBe(1);
      table.clear();
      expect(table.size).toBe(0);
      expect(table.getPeers()).toEqual([]);
    });
  });

  // .........................................................................
  // on / off
  // .........................................................................

  describe('on / off', () => {
    it('off removes a listener', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      const joined: string[] = [];
      const cb = (peer: NodeInfo) => joined.push(peer.nodeId);

      table.on('peer-joined', cb);
      layer.addPeer(testPeer('node-1'));
      expect(joined).toEqual(['node-1']);

      table.off('peer-joined', cb);
      layer.addPeer(testPeer('node-2'));
      expect(joined).toEqual(['node-1']); // not called again
    });

    it('supports multiple listeners on the same event', () => {
      const layer = new MockLayer('layer-a');
      table.attachLayer(layer);

      const listA: string[] = [];
      const listB: string[] = [];
      table.on('peer-joined', (peer) => listA.push(peer.nodeId));
      table.on('peer-joined', (peer) => listB.push(peer.nodeId));

      layer.addPeer(testPeer('node-1'));
      expect(listA).toEqual(['node-1']);
      expect(listB).toEqual(['node-1']);
    });
  });
});
