// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  CloudLayer,
  defaultCreateCloudHttpClient,
  type CloudHttpClient,
  type CloudPeerListResponse,
} from '../../src/layers/cloud-layer.ts';
import { NodeIdentity } from '../../src/identity/node-identity.ts';
import type { NodeInfo } from '../../src/types/node-info.ts';
import type { PeerProbe } from '../../src/types/peer-probe.ts';

// .............................................................................

/** Create a minimal NodeIdentity for testing */
function testIdentity(overrides?: Partial<NodeInfo>): NodeIdentity {
  return new NodeIdentity({
    nodeId: 'test-node-1',
    hostname: 'test-host',
    localIps: ['10.0.0.1'],
    domain: 'test-domain',
    port: 3000,
    startedAt: 1700000000000,
    ...overrides,
  });
}

/** Create a fake peer NodeInfo */
function fakePeer(id: string, domain = 'test-domain'): NodeInfo {
  return {
    nodeId: id,
    hostname: `host-${id}`,
    localIps: ['10.0.0.2'],
    domain,
    port: 3001,
    startedAt: 1700000001000,
  };
}

// .............................................................................

/**
 * In-memory mock cloud service for testing.
 *
 * Tracks register/poll/report calls and returns configurable responses.
 */
class MockCloudService implements CloudHttpClient {
  registerCalls: Array<{ endpoint: string; info: NodeInfo; apiKey?: string }> =
    [];
  pollCalls: Array<{
    endpoint: string;
    nodeId: string;
    domain: string;
    apiKey?: string;
  }> = [];
  reportCalls: Array<{
    endpoint: string;
    nodeId: string;
    probes: PeerProbe[];
    apiKey?: string;
  }> = [];

  /** Response to return from register/poll */
  nextResponse: CloudPeerListResponse = { peers: [], assignedHub: null };

  /** If set, register() throws this error */
  registerError: Error | null = null;

  /** If set, poll() throws this error */
  pollError: Error | null = null;

  /** If set, reportProbes() throws this error */
  reportError: Error | null = null;

  async register(
    endpoint: string,
    info: NodeInfo,
    apiKey?: string,
  ): Promise<CloudPeerListResponse> {
    this.registerCalls.push({ endpoint, info, apiKey });
    if (this.registerError) throw this.registerError;
    return this.nextResponse;
  }

  async poll(
    endpoint: string,
    nodeId: string,
    domain: string,
    apiKey?: string,
  ): Promise<CloudPeerListResponse> {
    this.pollCalls.push({ endpoint, nodeId, domain, apiKey });
    if (this.pollError) throw this.pollError;
    return this.nextResponse;
  }

  async reportProbes(
    endpoint: string,
    nodeId: string,
    probes: PeerProbe[],
    apiKey?: string,
  ): Promise<void> {
    this.reportCalls.push({ endpoint, nodeId, probes, apiKey });
    if (this.reportError) throw this.reportError;
  }
}

// .............................................................................

describe('CloudLayer', () => {
  let cloud: MockCloudService;
  let layer: CloudLayer;

  beforeEach(() => {
    cloud = new MockCloudService();
    layer = new CloudLayer(
      {
        enabled: true,
        endpoint: 'https://cloud.example.com',
        apiKey: 'test-key',
        pollIntervalMs: 60000, // Long interval — manual polling in tests
      },
      { createHttpClient: () => cloud },
    );
  });

  afterEach(async () => {
    if (layer.isActive()) {
      await layer.stop();
    }
  });

  // .........................................................................
  // Basic properties
  // .........................................................................

  it('has name "cloud"', () => {
    expect(layer.name).toBe('cloud');
  });

  it('is not active before start', () => {
    expect(layer.isActive()).toBe(false);
  });

  it('has no peers before start', () => {
    expect(layer.getPeers()).toEqual([]);
  });

  it('has no assigned hub before start', () => {
    expect(layer.getAssignedHub()).toBeNull();
  });

  it('uses default HTTP client when no deps provided', () => {
    const defaultLayer = new CloudLayer({
      enabled: true,
      endpoint: 'https://cloud.example.com',
    });
    // Should construct without error — uses defaultCreateCloudHttpClient
    expect(defaultLayer.name).toBe('cloud');
  });

  // .........................................................................
  // start — disabled / no config
  // .........................................................................

  describe('start — disabled', () => {
    it('returns false when enabled is false', async () => {
      const disabled = new CloudLayer(
        { enabled: false, endpoint: 'https://cloud.example.com' },
        { createHttpClient: () => cloud },
      );
      const result = await disabled.start(testIdentity());
      expect(result).toBe(false);
      expect(disabled.isActive()).toBe(false);
    });

    it('returns false when config is undefined', async () => {
      const noConfig = new CloudLayer(undefined, {
        createHttpClient: () => cloud,
      });
      const result = await noConfig.start(testIdentity());
      expect(result).toBe(false);
    });

    it('returns false when endpoint is empty', async () => {
      const emptyEndpoint = new CloudLayer(
        { enabled: true, endpoint: '' },
        { createHttpClient: () => cloud },
      );
      const result = await emptyEndpoint.start(testIdentity());
      expect(result).toBe(false);
    });
  });

  // .........................................................................
  // start — registration
  // .........................................................................

  describe('start — registration', () => {
    it('registers with cloud on start', async () => {
      await layer.start(testIdentity());

      expect(cloud.registerCalls).toHaveLength(1);
      expect(cloud.registerCalls[0]!.endpoint).toBe(
        'https://cloud.example.com',
      );
      expect(cloud.registerCalls[0]!.info.nodeId).toBe('test-node-1');
      expect(cloud.registerCalls[0]!.apiKey).toBe('test-key');
    });

    it('returns true on successful registration', async () => {
      const result = await layer.start(testIdentity());
      expect(result).toBe(true);
      expect(layer.isActive()).toBe(true);
    });

    it('returns false when cloud is unreachable', async () => {
      cloud.registerError = new Error('ECONNREFUSED');
      const result = await layer.start(testIdentity());
      expect(result).toBe(false);
      expect(layer.isActive()).toBe(false);
    });

    it('processes initial peer list from registration', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: 'peer-a',
      };

      await layer.start(testIdentity());

      expect(layer.getPeers()).toHaveLength(2);
      expect(layer.getAssignedHub()).toBe('peer-a');
    });

    it('emits peer-discovered for initial peers', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };

      const discovered: NodeInfo[] = [];
      layer.on('peer-discovered', (peer) => discovered.push(peer));

      await layer.start(testIdentity());

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.nodeId).toBe('peer-a');
    });

    it('emits hub-assigned when cloud assigns a hub', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: 'peer-a',
      };

      const hubs: Array<string | null> = [];
      layer.on('hub-assigned', (hubId) => hubs.push(hubId));

      await layer.start(testIdentity());

      expect(hubs).toEqual(['peer-a']);
    });

    it('does not emit hub-assigned when hub is null initially', async () => {
      cloud.nextResponse = { peers: [], assignedHub: null };

      const hubs: Array<string | null> = [];
      layer.on('hub-assigned', (hubId) => hubs.push(hubId));

      await layer.start(testIdentity());

      // null → null = no change
      expect(hubs).toHaveLength(0);
    });

    it('excludes self from peer list', async () => {
      cloud.nextResponse = {
        peers: [
          fakePeer('test-node-1'), // same nodeId as identity
          fakePeer('peer-a'),
        ],
        assignedHub: null,
      };

      await layer.start(testIdentity());

      expect(layer.getPeers()).toHaveLength(1);
      expect(layer.getPeers()[0]!.nodeId).toBe('peer-a');
    });
  });

  // .........................................................................
  // Polling
  // .........................................................................

  describe('polling', () => {
    it('polls the cloud at the configured interval', async () => {
      vi.useFakeTimers();
      const fastLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 1000,
        },
        { createHttpClient: () => cloud },
      );

      await fastLayer.start(testIdentity());
      expect(cloud.pollCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(cloud.pollCalls).toHaveLength(1);
      expect(cloud.pollCalls[0]!.nodeId).toBe('test-node-1');
      expect(cloud.pollCalls[0]!.domain).toBe('test-domain');

      await vi.advanceTimersByTimeAsync(1000);
      expect(cloud.pollCalls).toHaveLength(2);

      await fastLayer.stop();
      vi.useRealTimers();
    });

    it('discovers new peers from poll response', async () => {
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );

      // Start with no peers
      cloud.nextResponse = { peers: [], assignedHub: null };
      await pollLayer.start(testIdentity());
      expect(pollLayer.getPeers()).toHaveLength(0);

      const discovered: NodeInfo[] = [];
      pollLayer.on('peer-discovered', (peer) => discovered.push(peer));

      // Next poll returns a new peer
      cloud.nextResponse = {
        peers: [fakePeer('new-peer')],
        assignedHub: null,
      };
      await vi.advanceTimersByTimeAsync(100);

      expect(discovered).toHaveLength(1);
      expect(discovered[0]!.nodeId).toBe('new-peer');

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('removes peers no longer in cloud response', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: null,
      };
      await layer.start(testIdentity());
      expect(layer.getPeers()).toHaveLength(2);

      const lost: string[] = [];
      layer.on('peer-lost', (nodeId) => lost.push(nodeId));

      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: null,
      };
      await pollLayer.start(testIdentity());
      expect(pollLayer.getPeers()).toHaveLength(2);

      pollLayer.on('peer-lost', (nodeId) => lost.push(nodeId));

      // Next poll: peer-b disappears
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };
      await vi.advanceTimersByTimeAsync(100);

      expect(lost).toContain('peer-b');
      expect(pollLayer.getPeers()).toHaveLength(1);

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('updates hub assignment from poll', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      await pollLayer.start(testIdentity());

      const hubs: Array<string | null> = [];
      pollLayer.on('hub-assigned', (hubId) => hubs.push(hubId));

      // Cloud assigns hub on next poll
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: 'peer-a',
      };
      await vi.advanceTimersByTimeAsync(100);

      expect(hubs).toEqual(['peer-a']);
      expect(pollLayer.getAssignedHub()).toBe('peer-a');

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('survives poll failure gracefully', async () => {
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      await pollLayer.start(testIdentity());

      cloud.pollError = new Error('Network timeout');

      // Should not throw
      await vi.advanceTimersByTimeAsync(100);

      expect(pollLayer.isActive()).toBe(true);

      await pollLayer.stop();
      vi.useRealTimers();
    });

    it('uses default pollIntervalMs when not configured', async () => {
      vi.useFakeTimers();
      const defaultLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          // No pollIntervalMs → defaults to 30000
        },
        { createHttpClient: () => cloud },
      );
      await defaultLayer.start(testIdentity());

      await vi.advanceTimersByTimeAsync(29999);
      expect(cloud.pollCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(cloud.pollCalls).toHaveLength(1);

      await defaultLayer.stop();
      vi.useRealTimers();
    });
  });

  // .........................................................................
  // Probe reporting
  // .........................................................................

  describe('reportProbes', () => {
    it('reports probe results to the cloud', async () => {
      await layer.start(testIdentity());

      const probes: PeerProbe[] = [
        {
          nodeId: 'peer-a',
          address: '10.0.0.2:3001',
          reachable: true,
          latencyMs: 1.5,
          timestamp: Date.now(),
          probedBy: 'test-node-1',
        },
      ];

      await layer.reportProbes(probes);

      expect(cloud.reportCalls).toHaveLength(1);
      expect(cloud.reportCalls[0]!.nodeId).toBe('test-node-1');
      expect(cloud.reportCalls[0]!.probes).toEqual(probes);
      expect(cloud.reportCalls[0]!.apiKey).toBe('test-key');
    });

    it('survives report failure gracefully', async () => {
      await layer.start(testIdentity());
      cloud.reportError = new Error('Server error');

      // Should not throw
      await expect(layer.reportProbes([])).resolves.toBeUndefined();
    });
  });

  // .........................................................................
  // stop
  // .........................................................................

  describe('stop', () => {
    it('emits peer-lost for all peers on stop', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a'), fakePeer('peer-b')],
        assignedHub: 'peer-a',
      };
      await layer.start(testIdentity());

      const lost: string[] = [];
      layer.on('peer-lost', (nodeId) => lost.push(nodeId));

      await layer.stop();

      expect(lost).toContain('peer-a');
      expect(lost).toContain('peer-b');
    });

    it('clears all state on stop', async () => {
      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: 'peer-a',
      };
      await layer.start(testIdentity());

      await layer.stop();

      expect(layer.isActive()).toBe(false);
      expect(layer.getPeers()).toEqual([]);
      expect(layer.getAssignedHub()).toBeNull();
    });

    it('stops polling on stop', async () => {
      vi.useFakeTimers();
      const pollLayer = new CloudLayer(
        {
          enabled: true,
          endpoint: 'https://cloud.example.com',
          pollIntervalMs: 100,
        },
        { createHttpClient: () => cloud },
      );
      await pollLayer.start(testIdentity());
      await pollLayer.stop();

      cloud.pollCalls = [];
      await vi.advanceTimersByTimeAsync(500);

      // No polls after stop
      expect(cloud.pollCalls).toHaveLength(0);

      vi.useRealTimers();
    });

    it('stop is safe when not started', async () => {
      const notStarted = new CloudLayer(
        { enabled: true, endpoint: 'https://cloud.example.com' },
        { createHttpClient: () => cloud },
      );
      await expect(notStarted.stop()).resolves.toBeUndefined();
    });
  });

  // .........................................................................
  // Events
  // .........................................................................

  describe('events', () => {
    it('on/off subscribe/unsubscribe', async () => {
      const discovered: NodeInfo[] = [];
      const cb = (peer: NodeInfo): void => {
        discovered.push(peer);
      };

      cloud.nextResponse = {
        peers: [fakePeer('peer-a')],
        assignedHub: null,
      };

      layer.on('peer-discovered', cb);
      await layer.start(testIdentity());

      expect(discovered).toHaveLength(1);

      layer.off('peer-discovered', cb);

      // Trigger another response via new start
      await layer.stop();
      cloud.nextResponse = {
        peers: [fakePeer('peer-b')],
        assignedHub: null,
      };
      await layer.start(testIdentity());

      // Should still be 1 — callback was unsubscribed
      expect(discovered).toHaveLength(1);
    });

    it('delivers to multiple listeners for the same event', async () => {
      const results: string[] = [];
      layer.on('peer-discovered', (p) => results.push(`A:${p.nodeId}`));
      layer.on('peer-discovered', (p) => results.push(`B:${p.nodeId}`));

      cloud.nextResponse = {
        peers: [fakePeer('peer-x')],
        assignedHub: null,
      };
      await layer.start(testIdentity());

      expect(results).toEqual(['A:peer-x', 'B:peer-x']);
    });
  });

  // .........................................................................
  // defaultCreateCloudHttpClient
  // .........................................................................

  describe('defaultCreateCloudHttpClient', () => {
    it('creates an HTTP client', () => {
      const client = defaultCreateCloudHttpClient();
      expect(client).toBeDefined();
      expect(typeof client.register).toBe('function');
      expect(typeof client.poll).toBe('function');
      expect(typeof client.reportProbes).toBe('function');
    });

    it('register calls fetch with correct args', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const info = testIdentity().toNodeInfo();
      await client.register('https://cloud.test', info, 'my-key');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cloud.test/register');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['Authorization']).toBe('Bearer my-key');
      expect(JSON.parse(opts.body as string)).toEqual(info);

      vi.unstubAllGlobals();
    });

    it('register throws on non-ok response', async () => {
      const client = defaultCreateCloudHttpClient();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      );

      await expect(
        client.register('https://cloud.test', testIdentity().toNodeInfo()),
      ).rejects.toThrow('Cloud register failed: 500');

      vi.unstubAllGlobals();
    });

    it('register works without apiKey', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.register('https://cloud.test', testIdentity().toNodeInfo());

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['Authorization']).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('poll calls fetch with correct args', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.poll('https://cloud.test', 'node-1', 'my-domain', 'key-1');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toContain('https://cloud.test/peers?');
      expect(url).toContain('nodeId=node-1');
      expect(url).toContain('domain=my-domain');
      expect(opts.method).toBe('GET');
      expect(opts.headers['Authorization']).toBe('Bearer key-1');

      vi.unstubAllGlobals();
    });

    it('poll throws on non-ok response', async () => {
      const client = defaultCreateCloudHttpClient();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 403 }),
      );

      await expect(
        client.poll('https://cloud.test', 'node-1', 'dom'),
      ).rejects.toThrow('Cloud poll failed: 403');

      vi.unstubAllGlobals();
    });

    it('poll works without apiKey', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ peers: [], assignedHub: null }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.poll('https://cloud.test', 'node-1', 'dom');

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['Authorization']).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('reportProbes calls fetch with correct args', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const probes: PeerProbe[] = [
        {
          nodeId: 'peer-1',
          address: '10.0.0.2:3001',
          reachable: true,
          latencyMs: 2.0,
          timestamp: 1700000000000,
          probedBy: 'node-1',
        },
      ];

      await client.reportProbes(
        'https://cloud.test',
        'node-1',
        probes,
        'key-1',
      );

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cloud.test/probes');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Authorization']).toBe('Bearer key-1');
      const body = JSON.parse(opts.body as string);
      expect(body.nodeId).toBe('node-1');
      expect(body.probes).toEqual(probes);

      vi.unstubAllGlobals();
    });

    it('reportProbes throws on non-ok response', async () => {
      const client = defaultCreateCloudHttpClient();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 502 }),
      );

      await expect(
        client.reportProbes('https://cloud.test', 'node-1', []),
      ).rejects.toThrow('Cloud reportProbes failed: 502');

      vi.unstubAllGlobals();
    });

    it('reportProbes works without apiKey', async () => {
      const client = defaultCreateCloudHttpClient();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await client.reportProbes('https://cloud.test', 'node-1', []);

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['Authorization']).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });
});
