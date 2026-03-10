// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, beforeEach } from 'vitest';

import { ManualLayer } from '../../src/layers/manual-layer';
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

describe('ManualLayer', () => {
  let layer: ManualLayer;

  beforeEach(() => {
    layer = new ManualLayer();
  });

  // .........................................................................
  // Basic properties
  // .........................................................................

  it('has name "manual"', () => {
    expect(layer.name).toBe('manual');
  });

  it('is not active before start', () => {
    expect(layer.isActive()).toBe(false);
  });

  // .........................................................................
  // start / stop lifecycle
  // .........................................................................

  describe('start', () => {
    it('always returns true — cannot be disabled', async () => {
      const result = await layer.start(testIdentity());
      expect(result).toBe(true);
    });

    it('sets isActive to true', async () => {
      await layer.start(testIdentity());
      expect(layer.isActive()).toBe(true);
    });
  });

  describe('stop', () => {
    it('sets isActive to false', async () => {
      await layer.start(testIdentity());
      await layer.stop();
      expect(layer.isActive()).toBe(false);
    });

    it('clears assigned hub on stop', async () => {
      await layer.start(testIdentity());
      layer.assignHub('some-node');
      expect(layer.getAssignedHub()).toBe('some-node');

      await layer.stop();
      expect(layer.getAssignedHub()).toBeNull();
    });

    it('clears event listeners on stop', async () => {
      await layer.start(testIdentity());
      let callCount = 0;
      layer.on('hub-assigned', () => callCount++);
      layer.assignHub('node-a');
      expect(callCount).toBe(1);

      await layer.stop();
      // After stop, listeners are cleared — re-subscribing and assigning
      // should not trigger the old listener
      await layer.start(testIdentity());
      layer.assignHub('node-b');
      expect(callCount).toBe(1); // old listener not called
    });
  });

  // .........................................................................
  // getPeers — manual layer never discovers peers
  // .........................................................................

  describe('getPeers', () => {
    it('always returns empty array', async () => {
      await layer.start(testIdentity());
      expect(layer.getPeers()).toEqual([]);
    });

    it('returns empty array even after hub assignment', async () => {
      await layer.start(testIdentity());
      layer.assignHub('some-node');
      expect(layer.getPeers()).toEqual([]);
    });
  });

  // .........................................................................
  // assignHub / clearOverride / getAssignedHub
  // .........................................................................

  describe('assignHub', () => {
    it('sets the assigned hub', async () => {
      await layer.start(testIdentity());
      layer.assignHub('forced-hub-id');
      expect(layer.getAssignedHub()).toBe('forced-hub-id');
    });

    it('can reassign to a different hub', async () => {
      await layer.start(testIdentity());
      layer.assignHub('hub-1');
      layer.assignHub('hub-2');
      expect(layer.getAssignedHub()).toBe('hub-2');
    });

    it('emits hub-assigned event with the nodeId', async () => {
      await layer.start(testIdentity());
      const events: (string | null)[] = [];
      layer.on('hub-assigned', (nodeId) => events.push(nodeId));

      layer.assignHub('hub-x');
      expect(events).toEqual(['hub-x']);
    });
  });

  describe('clearOverride', () => {
    it('sets assigned hub to null', async () => {
      await layer.start(testIdentity());
      layer.assignHub('some-hub');
      layer.clearOverride();
      expect(layer.getAssignedHub()).toBeNull();
    });

    it('emits hub-assigned event with null', async () => {
      await layer.start(testIdentity());
      const events: (string | null)[] = [];
      layer.on('hub-assigned', (nodeId) => events.push(nodeId));

      layer.assignHub('hub-1');
      layer.clearOverride();
      expect(events).toEqual(['hub-1', null]);
    });

    it('is idempotent — clearing when already null is safe', async () => {
      await layer.start(testIdentity());
      const events: (string | null)[] = [];
      layer.on('hub-assigned', (nodeId) => events.push(nodeId));

      layer.clearOverride();
      layer.clearOverride();
      expect(events).toEqual([null, null]);
      expect(layer.getAssignedHub()).toBeNull();
    });
  });

  describe('getAssignedHub', () => {
    it('returns null before any assignment', () => {
      expect(layer.getAssignedHub()).toBeNull();
    });
  });

  // .........................................................................
  // Event handling: on / off
  // .........................................................................

  describe('on / off', () => {
    it('supports multiple listeners for the same event', async () => {
      await layer.start(testIdentity());
      const results1: string[] = [];
      const results2: string[] = [];

      const cb1 = (id: string | null) => results1.push(id ?? 'null');
      const cb2 = (id: string | null) => results2.push(id ?? 'null');

      layer.on('hub-assigned', cb1);
      layer.on('hub-assigned', cb2);

      layer.assignHub('hub-1');
      expect(results1).toEqual(['hub-1']);
      expect(results2).toEqual(['hub-1']);
    });

    it('off removes a specific listener', async () => {
      await layer.start(testIdentity());
      const results: string[] = [];
      const cb = (id: string | null) => results.push(id ?? 'null');

      layer.on('hub-assigned', cb);
      layer.assignHub('hub-1');
      expect(results).toEqual(['hub-1']);

      layer.off('hub-assigned', cb);
      layer.assignHub('hub-2');
      expect(results).toEqual(['hub-1']); // not called again
    });

    it('off with unknown listener is safe (no-op)', async () => {
      await layer.start(testIdentity());
      const cb = () => {};
      // Should not throw
      layer.on('hub-assigned', cb);
      layer.off('hub-assigned', cb);
      layer.off('hub-assigned', cb); // already removed
    });

    it('supports peer-discovered and peer-lost event types', async () => {
      await layer.start(testIdentity());
      const peerEvents: NodeInfo[] = [];
      const lostEvents: string[] = [];

      layer.on('peer-discovered', (peer) => peerEvents.push(peer));
      layer.on('peer-lost', (nodeId) => lostEvents.push(nodeId));

      // ManualLayer never emits these, but the interface is supported
      expect(peerEvents).toEqual([]);
      expect(lostEvents).toEqual([]);
    });
  });
});
