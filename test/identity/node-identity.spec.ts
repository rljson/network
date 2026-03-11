// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';

import {
  NodeIdentity,
  parseLocalIps,
  defaultNodeIdentityDeps,
} from '../../src/identity/node-identity';

// .............................................................................

/** Creates mock deps that avoid real filesystem and OS calls */
function mockDeps(overrides?: Record<string, unknown>) {
  const written: Record<string, string> = {};
  return {
    deps: {
      readNodeId: async (): Promise<string | null> => null,
      writeNodeId: async (filePath: string, nodeId: string): Promise<void> => {
        written[filePath] = nodeId;
      },
      hostname: () => 'test-host',
      localIps: () => ['10.0.0.1'],
      randomUUID: () => 'generated-uuid-1234',
      now: () => 1700000000000,
      homedir: () => '/mock/home',
      ...overrides,
    },
    written,
  };
}

// .............................................................................

describe('parseLocalIps', () => {
  it('extracts IPv4 non-internal addresses', () => {
    const interfaces = {
      eth0: [
        {
          address: '192.168.1.42',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.1.42/24',
        },
      ],
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    };
    expect(parseLocalIps(interfaces)).toEqual(['192.168.1.42']);
  });

  it('skips IPv6 addresses', () => {
    const interfaces = {
      eth0: [
        {
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          family: 'IPv6' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: 'fe80::1/64',
          scopeid: 1,
        },
      ],
    };
    expect(parseLocalIps(interfaces)).toEqual([]);
  });

  it('returns empty array for empty interfaces', () => {
    expect(parseLocalIps({})).toEqual([]);
  });

  it('handles multiple interfaces with multiple addresses', () => {
    const interfaces = {
      eth0: [
        {
          address: '192.168.1.42',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.1.42/24',
        },
      ],
      wlan0: [
        {
          address: '10.0.0.5',
          netmask: '255.255.255.0',
          family: 'IPv4' as const,
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '10.0.0.5/24',
        },
      ],
    };
    expect(parseLocalIps(interfaces)).toEqual(['192.168.1.42', '10.0.0.5']);
  });
});

// .............................................................................

describe('defaultNodeIdentityDeps', () => {
  const tempBase = join(tmpdir(), 'rljson-network-test-' + Date.now());

  it('returns an object with all required functions', () => {
    const deps = defaultNodeIdentityDeps();
    expect(typeof deps.readNodeId).toBe('function');
    expect(typeof deps.writeNodeId).toBe('function');
    expect(typeof deps.hostname).toBe('function');
    expect(typeof deps.localIps).toBe('function');
    expect(typeof deps.randomUUID).toBe('function');
    expect(typeof deps.now).toBe('function');
    expect(typeof deps.homedir).toBe('function');
  });

  it('hostname returns a string', () => {
    const deps = defaultNodeIdentityDeps();
    expect(typeof deps.hostname()).toBe('string');
    expect(deps.hostname().length).toBeGreaterThan(0);
  });

  it('localIps returns an array', () => {
    const deps = defaultNodeIdentityDeps();
    const ips = deps.localIps();
    expect(Array.isArray(ips)).toBe(true);
  });

  it('randomUUID returns a valid UUID', () => {
    const deps = defaultNodeIdentityDeps();
    const uuid = deps.randomUUID();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('now returns a number', () => {
    const deps = defaultNodeIdentityDeps();
    const now = deps.now();
    expect(typeof now).toBe('number');
    expect(now).toBeGreaterThan(0);
  });

  it('homedir returns a string', () => {
    const deps = defaultNodeIdentityDeps();
    expect(typeof deps.homedir()).toBe('string');
  });

  it('writeNodeId creates directories and writes file', async () => {
    const deps = defaultNodeIdentityDeps();
    const filePath = join(tempBase, 'write-test', 'node-id');
    await deps.writeNodeId(filePath, 'test-uuid-write');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('test-uuid-write');
    await rm(tempBase, { recursive: true, force: true });
  });

  it('readNodeId reads existing file', async () => {
    const deps = defaultNodeIdentityDeps();
    const dir = join(tempBase, 'read-test');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'node-id');
    await writeFile(filePath, '  existing-uuid  ', 'utf-8');
    const result = await deps.readNodeId(filePath);
    expect(result).toBe('existing-uuid');
    await rm(tempBase, { recursive: true, force: true });
  });

  it('readNodeId returns null for missing file', async () => {
    const deps = defaultNodeIdentityDeps();
    const result = await deps.readNodeId(
      join(tempBase, 'nonexistent', 'node-id'),
    );
    expect(result).toBeNull();
  });
});

// .............................................................................

describe('NodeIdentity', () => {
  describe('constructor', () => {
    it('sets all fields from NodeInfo', () => {
      const identity = new NodeIdentity({
        nodeId: 'test-id',
        hostname: 'my-host',
        localIps: ['192.168.1.1'],
        domain: 'test-domain',
        port: 3000,
        startedAt: 1700000000000,
      });

      expect(identity.nodeId).toBe('test-id');
      expect(identity.hostname).toBe('my-host');
      expect(identity.localIps).toEqual(['192.168.1.1']);
      expect(identity.domain).toBe('test-domain');
      expect(identity.port).toBe(3000);
      expect(identity.startedAt).toBe(1700000000000);
    });

    it('makes a defensive copy of localIps', () => {
      const ips = ['10.0.0.1', '10.0.0.2'];
      const identity = new NodeIdentity({
        nodeId: 'id',
        hostname: 'h',
        localIps: ips,
        domain: 'd',
        port: 1,
        startedAt: 0,
      });
      ips.push('10.0.0.3');
      expect(identity.localIps).toEqual(['10.0.0.1', '10.0.0.2']);
    });
  });

  describe('toNodeInfo', () => {
    it('returns a plain NodeInfo object', () => {
      const identity = new NodeIdentity({
        nodeId: 'test-id',
        hostname: 'my-host',
        localIps: ['10.0.0.1'],
        domain: 'test',
        port: 4000,
        startedAt: 1700000000000,
      });

      const info = identity.toNodeInfo();
      expect(info).toEqual({
        nodeId: 'test-id',
        hostname: 'my-host',
        localIps: ['10.0.0.1'],
        domain: 'test',
        port: 4000,
        startedAt: 1700000000000,
      });
    });

    it('returns a copy — modifying it does not affect the identity', () => {
      const identity = new NodeIdentity({
        nodeId: 'id',
        hostname: 'h',
        localIps: ['1.2.3.4'],
        domain: 'd',
        port: 1,
        startedAt: 0,
      });
      const info = identity.toNodeInfo();
      info.localIps.push('5.6.7.8');
      expect(identity.localIps).toEqual(['1.2.3.4']);
    });
  });

  describe('create', () => {
    it('generates new UUID on first run', async () => {
      const { deps, written } = mockDeps();
      const identity = await NodeIdentity.create({
        domain: 'test-domain',
        port: 3000,
        deps,
      });

      expect(identity.nodeId).toBe('generated-uuid-1234');
      expect(identity.hostname).toBe('test-host');
      expect(identity.localIps).toEqual(['10.0.0.1']);
      expect(identity.domain).toBe('test-domain');
      expect(identity.port).toBe(3000);
      expect(identity.startedAt).toBe(1700000000000);

      // Verify UUID was persisted
      const writtenPath = Object.keys(written)[0]!;
      expect(writtenPath).toContain('test-domain');
      expect(writtenPath).toContain('node-id');
      expect(written[writtenPath]).toBe('generated-uuid-1234');
    });

    it('reads existing UUID on subsequent runs', async () => {
      const { deps } = mockDeps({
        readNodeId: async () => 'existing-uuid-5678',
      });
      const writeNodeId = deps.writeNodeId;
      let writeCalled = false;
      deps.writeNodeId = async (filePath: string, nodeId: string) => {
        writeCalled = true;
        await writeNodeId(filePath, nodeId);
      };

      const identity = await NodeIdentity.create({
        domain: 'test-domain',
        port: 3000,
        deps,
      });

      expect(identity.nodeId).toBe('existing-uuid-5678');
      expect(writeCalled).toBe(false);
    });

    it('uses custom identityDir when provided', async () => {
      const { deps, written } = mockDeps();
      await NodeIdentity.create({
        domain: 'my-domain',
        port: 5000,
        identityDir: '/custom/identity',
        deps,
      });

      const writtenPath = Object.keys(written)[0]!;
      expect(writtenPath).toContain('/custom/identity');
      expect(writtenPath).toContain('my-domain');
    });

    it('uses default identityDir from homedir when not provided', async () => {
      const { deps, written } = mockDeps();
      await NodeIdentity.create({
        domain: 'default-dir-test',
        port: 3000,
        deps,
      });

      const writtenPath = Object.keys(written)[0]!;
      expect(writtenPath).toContain('/mock/home/.rljson-network');
    });
  });
});
