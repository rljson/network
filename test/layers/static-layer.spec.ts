// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, beforeEach } from 'vitest';

import { StaticLayer } from '../../src/layers/static-layer';
import { NodeIdentity } from '../../src/identity/node-identity';
import type { NodeInfo } from '../../src/types/node-info';

// .............................................................................

/** Create a minimal NodeIdentity for testing */
function testIdentity(): NodeIdentity {
  return new NodeIdentity({
    nodeId: 'test-node-1',
    hostname: 'test-host',
    localIps: ['10.0.0.1'],
    domain: 'test',
    port: 3000,
    startedAt: 1700000000000,
  });
}

// .............................................................................

describe('StaticLayer', () => {
  // .........................................................................
  // Basic properties
  // .........................................................................

  it('has name "static"', () => {
    const layer = new StaticLayer();
    expect(layer.name).toBe('static');
  });

  it('is not active before start', () => {
    const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
    expect(layer.isActive()).toBe(false);
  });

  // .........................................................................
  // start — with hubAddress configured
  // .........................................................................

  describe('start with hubAddress', () => {
    let layer: StaticLayer;

    beforeEach(() => {
      layer = new StaticLayer({ hubAddress: '192.168.1.100:4000' });
    });

    it('returns true when hubAddress is configured', async () => {
      const result = await layer.start(testIdentity());
      expect(result).toBe(true);
    });

    it('sets isActive to true', async () => {
      await layer.start(testIdentity());
      expect(layer.isActive()).toBe(true);
    });

    it('assigns a hub based on the address', async () => {
      await layer.start(testIdentity());
      const hubId = layer.getAssignedHub();
      expect(hubId).toBe('static-hub-192.168.1.100:4000');
    });

    it('returns hub address', async () => {
      await layer.start(testIdentity());
      expect(layer.getHubAddress()).toBe('192.168.1.100:4000');
    });

    it('creates a synthetic peer with correct fields', async () => {
      await layer.start(testIdentity());
      const peers = layer.getPeers();
      expect(peers).toHaveLength(1);

      const peer = peers[0]!;
      expect(peer.nodeId).toBe('static-hub-192.168.1.100:4000');
      expect(peer.hostname).toBe('static-192.168.1.100');
      expect(peer.localIps).toEqual(['192.168.1.100']);
      expect(peer.domain).toBe('test'); // from identity
      expect(peer.port).toBe(4000);
      expect(peer.startedAt).toBe(0); // unknown for static hub
    });

    it('emits peer-discovered event on start', async () => {
      const discovered: NodeInfo[] = [];
      layer.on('peer-discovered', (peer) => discovered.push(peer));

      await layer.start(testIdentity());

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.nodeId).toBe('static-hub-192.168.1.100:4000');
    });

    it('emits hub-assigned event on start', async () => {
      const assigned: (string | null)[] = [];
      layer.on('hub-assigned', (nodeId) => assigned.push(nodeId));

      await layer.start(testIdentity());

      expect(assigned).toEqual(['static-hub-192.168.1.100:4000']);
    });
  });

  // .........................................................................
  // start — without hubAddress
  // .........................................................................

  describe('start without hubAddress', () => {
    it('returns false when no config is provided', async () => {
      const layer = new StaticLayer();
      const result = await layer.start(testIdentity());
      expect(result).toBe(false);
    });

    it('returns false when hubAddress is undefined', async () => {
      const layer = new StaticLayer({});
      const result = await layer.start(testIdentity());
      expect(result).toBe(false);
    });

    it('does not set isActive', async () => {
      const layer = new StaticLayer();
      await layer.start(testIdentity());
      expect(layer.isActive()).toBe(false);
    });

    it('returns null for getAssignedHub', async () => {
      const layer = new StaticLayer();
      await layer.start(testIdentity());
      expect(layer.getAssignedHub()).toBeNull();
    });

    it('returns empty peers', async () => {
      const layer = new StaticLayer();
      await layer.start(testIdentity());
      expect(layer.getPeers()).toEqual([]);
    });
  });

  // .........................................................................
  // Address parsing edge cases
  // .........................................................................

  describe('address parsing', () => {
    it('handles address without port — defaults to 3000', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1' });
      await layer.start(testIdentity());
      const peer = layer.getPeers()[0]!;
      expect(peer.port).toBe(3000);
      expect(peer.localIps).toEqual(['10.0.0.1']);
    });

    it('handles address with custom port', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:9999' });
      await layer.start(testIdentity());
      const peer = layer.getPeers()[0]!;
      expect(peer.port).toBe(9999);
    });
  });

  // .........................................................................
  // stop
  // .........................................................................

  describe('stop', () => {
    it('sets isActive to false', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      await layer.start(testIdentity());
      await layer.stop();
      expect(layer.isActive()).toBe(false);
    });

    it('clears hub and peers', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      await layer.start(testIdentity());
      await layer.stop();
      expect(layer.getAssignedHub()).toBeNull();
      expect(layer.getHubAddress()).toBeNull();
      expect(layer.getPeers()).toEqual([]);
    });

    it('emits peer-lost event on stop', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      const lost: string[] = [];
      layer.on('peer-lost', (nodeId) => lost.push(nodeId));

      await layer.start(testIdentity());
      await layer.stop();

      expect(lost).toEqual(['static-hub-10.0.0.1:3000']);
    });

    it('does not emit peer-lost when never started', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      const lost: string[] = [];
      layer.on('peer-lost', (nodeId) => lost.push(nodeId));

      await layer.stop();
      expect(lost).toEqual([]);
    });

    it('clears listeners on stop', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      let count = 0;
      layer.on('hub-assigned', () => count++);

      await layer.start(testIdentity());
      expect(count).toBe(1);

      await layer.stop();
      // Re-start should not trigger old listener
      await layer.start(testIdentity());
      expect(count).toBe(1);
    });
  });

  // .........................................................................
  // Event handling: on / off
  // .........................................................................

  describe('on / off', () => {
    it('supports multiple listeners', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      const r1: string[] = [];
      const r2: string[] = [];

      layer.on('hub-assigned', (id) => r1.push(id ?? 'null'));
      layer.on('hub-assigned', (id) => r2.push(id ?? 'null'));

      await layer.start(testIdentity());
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
    });

    it('off removes a specific listener', async () => {
      const layer = new StaticLayer({ hubAddress: '10.0.0.1:3000' });
      const results: string[] = [];
      const cb = (id: string | null) => results.push(id ?? 'null');

      layer.on('hub-assigned', cb);
      layer.off('hub-assigned', cb);

      await layer.start(testIdentity());
      expect(results).toEqual([]); // removed before start
    });
  });
});
