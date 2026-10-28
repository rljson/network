// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { exampleNodeInfo, nodeInfoChanged } from '../../src/types/node-info';
import type { NodeInfo, NodeId } from '../../src/types/node-info';

describe('NodeInfo', () => {
  it('exampleNodeInfo has all required fields', () => {
    expect(exampleNodeInfo.nodeId).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(exampleNodeInfo.hostname).toBe('WORKSTATION-7');
    expect(exampleNodeInfo.localIps).toEqual(['192.168.1.42']);
    expect(exampleNodeInfo.domain).toBe('office-sync');
    expect(exampleNodeInfo.port).toBe(3000);
    expect(exampleNodeInfo.startedAt).toBe(1741123456789);
  });

  it('NodeId is a string type alias', () => {
    const id: NodeId = 'test-id';
    expect(id).toBe('test-id');
  });

  it('can create a custom NodeInfo', () => {
    const info: NodeInfo = {
      nodeId: 'custom-id',
      hostname: 'my-host',
      localIps: ['10.0.0.1', '10.0.0.2'],
      domain: 'test-domain',
      port: 4000,
      startedAt: 123456,
    };
    expect(info.localIps).toHaveLength(2);
  });

  describe('nodeInfoChanged', () => {
    const report = (changes: Partial<NodeInfo>): NodeInfo => ({
      ...exampleNodeInfo,
      localIps: [...exampleNodeInfo.localIps],
      ...changes,
    });

    it('is false for the same report again', () => {
      expect(nodeInfoChanged(exampleNodeInfo, report({}))).toBe(false);
    });

    it('sees a restart', () => {
      const startedAt = exampleNodeInfo.startedAt + 60_000;
      expect(nodeInfoChanged(exampleNodeInfo, report({ startedAt }))).toBe(true);
    });

    it('sees a new port', () => {
      expect(nodeInfoChanged(exampleNodeInfo, report({ port: 3001 }))).toBe(true);
    });

    it('sees a new host name', () => {
      const hostname = 'WORKSTATION-8';
      expect(nodeInfoChanged(exampleNodeInfo, report({ hostname }))).toBe(true);
    });

    it('sees an address added or replaced', () => {
      const added = report({ localIps: ['192.168.1.42', '10.0.0.7'] });
      const replaced = report({ localIps: ['192.168.1.43'] });
      expect(nodeInfoChanged(exampleNodeInfo, added)).toBe(true);
      expect(nodeInfoChanged(exampleNodeInfo, replaced)).toBe(true);
    });
  });
});
