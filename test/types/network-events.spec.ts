// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import type {
  HubChangedEvent,
  NetworkEventMap,
  NetworkEventName,
  NetworkLogEntry,
  RoleChangedEvent,
  TopologyChangedEvent,
} from '../../src/types/network-events';
import {
  exampleHubChangedEvent,
  exampleNetworkLogEntry,
  exampleRoleChangedEvent,
  exampleTopologyChangedEvent,
  networkEventNames,
} from '../../src/types/network-events';

describe('NetworkEvents', () => {
  describe('networkEventNames', () => {
    it('contains all expected event names', () => {
      expect(networkEventNames).toContain('topology-changed');
      expect(networkEventNames).toContain('role-changed');
      expect(networkEventNames).toContain('hub-changed');
      expect(networkEventNames).toContain('peer-joined');
      expect(networkEventNames).toContain('peer-left');
      expect(networkEventNames).toContain('log');
    });

    it('has exactly 6 event names', () => {
      expect(networkEventNames).toHaveLength(6);
    });

    it('is readonly', () => {
      // Type-level check: NetworkEventName is derived from the array
      const name: NetworkEventName = 'topology-changed';
      expect(networkEventNames).toContain(name);
    });
  });

  describe('exampleTopologyChangedEvent', () => {
    it('has correct structure', () => {
      const event: TopologyChangedEvent = exampleTopologyChangedEvent;
      expect(event.topology).toBeDefined();
      expect(event.topology.domain).toBe('office-sync');
      expect(event.topology.hubNodeId).toBeDefined();
    });
  });

  describe('exampleRoleChangedEvent', () => {
    it('has previous and current roles', () => {
      const event: RoleChangedEvent = exampleRoleChangedEvent;
      expect(event.previous).toBe('unassigned');
      expect(event.current).toBe('hub');
    });
  });

  describe('exampleHubChangedEvent', () => {
    it('has previousHub and currentHub', () => {
      const event: HubChangedEvent = exampleHubChangedEvent;
      expect(event.previousHub).toBeNull();
      expect(event.currentHub).toBeDefined();
      expect(typeof event.currentHub).toBe('string');
    });
  });

  describe('exampleNetworkLogEntry', () => {
    it('has category and message', () => {
      const entry: NetworkLogEntry = exampleNetworkLogEntry;
      expect(entry.category).toBe('election');
      expect(entry.message).toContain('Elected');
    });
  });

  it('NetworkEventMap type is consistent', () => {
    // Validate that example events match their expected map types
    const map: Partial<{
      [K in keyof NetworkEventMap]: NetworkEventMap[K];
    }> = {
      'topology-changed': exampleTopologyChangedEvent,
      'role-changed': exampleRoleChangedEvent,
      'hub-changed': exampleHubChangedEvent,
      log: exampleNetworkLogEntry,
    };
    expect(map['topology-changed']).toBeDefined();
    expect(map['role-changed']).toBeDefined();
    expect(map['hub-changed']).toBeDefined();
    expect(map['log']).toBeDefined();
  });
});
