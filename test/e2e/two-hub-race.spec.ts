// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  CloudHttpClient,
  CloudPeerListResponse,
} from '../../src/layers/cloud-layer';
import { NetworkManager } from '../../src/network-manager';
import type { NetworkConfig } from '../../src/types/network-config';
import type { NodeInfo } from '../../src/types/node-info';
import { MockUdpHub } from '../helpers/mock-udp.ts';

// .............................................................................

/**
 * Two machines of one site, and the cloud coordinator they register with.
 *
 * Seen on a lab: a machine that restarted while the other machine of its site
 * was hub came back as a SECOND hub, and both stayed hub for good.
 *
 * The host there keeps its own server on the hub port of every machine,
 * whatever the machine's role, so the probe listener cannot have the port. It
 * ran with probing off, and what is left then is the one-shot probe of a peer
 * FIRST heard by broadcast:
 *
 * - The returning machine learns its peer from the coordinator's register
 *   answer, long before the peer's next broadcast. A peer known from the
 *   cloud is never probed, and hearing its broadcast later is not a new peer,
 *   so this machine never elects: it takes the coordinator's word for good.
 * - The running machine hears the newcomer's broadcast first, probes it once,
 *   and reports it reachable. Its own election keeps itself as the incumbent,
 *   on that one probe, for good.
 * - The coordinator names the node most peers report reachable — the
 *   newcomer, the only node anyone has reported. The newcomer becomes hub.
 *
 * `probing.listen: false` is the way out: every machine probes every peer each
 * cycle, and the host's server answers the probes in place of a listener.
 *
 * Real here: the network managers, the TCP probes and the host servers they
 * probe. Stand-ins: UDP broadcast, and the coordinator below.
 */

/**
 * A hosted coordinator's answer under its default hub policy (`manual`):
 * one registered node is its own hub; otherwise the node the most peers
 * report reachable, then the earliest `startedAt`, then the `nodeId`; with no
 * reachable report at all, its last answer while that node is still
 * registered, else the earliest start. Reports are kept per pair and survive
 * a re-registration.
 */
class Coordinator {
  readonly nodes = new Map<string, NodeInfo>();
  readonly reports = new Map<string, boolean>();
  last: string | null = null;

  answer(): CloudPeerListResponse {
    const peers = [...this.nodes.values()];
    const reach = (id: string): number =>
      peers.filter(
        (p) => p.nodeId !== id && this.reports.get(`${p.nodeId}|${id}`) === true,
      ).length;
    const byStart = (a: NodeInfo, b: NodeInfo): number =>
      a.startedAt - b.startedAt || a.nodeId.localeCompare(b.nodeId);
    let hub: string | null = null;
    if (peers.length === 1) hub = peers[0]!.nodeId;
    else if (peers.length > 1) {
      const ranked = [...peers].sort(
        (a, b) => reach(b.nodeId) - reach(a.nodeId) || byStart(a, b),
      );
      if (reach(ranked[0]!.nodeId) > 0) hub = ranked[0]!.nodeId;
      else if (this.last !== null && this.nodes.has(this.last)) hub = this.last;
      else hub = [...peers].sort(byStart)[0]!.nodeId;
    }
    this.last = hub;
    return { peers, assignedHub: hub, hubPolicy: 'manual' };
  }

  client(): CloudHttpClient {
    return {
      register: async (_endpoint, info) => {
        this.nodes.set(info.nodeId, info);
        return this.answer();
      },
      poll: async () => this.answer(),
      reportProbes: async (_endpoint, nodeId, probes) => {
        for (const p of probes) {
          this.reports.set(`${nodeId}|${p.toNodeId}`, p.reachable);
        }
      },
    };
  }
}

/** A host's own server on the hub port, as it runs on every machine. */
interface HostServer {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start a host server.
 * @param port - The port to hold; 0 for a free one.
 * @returns The running server.
 */
const hostServer = (port = 0): Promise<HostServer> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const identityDir = () => join(tmpdir(), 'two-hub-race-' + randomUUID());

// .............................................................................

describe('E2E: Two-hub race', () => {
  const machines: NetworkManager[] = [];
  const hosts: HostServer[] = [];
  let udp: MockUdpHub;
  let coordinator: Coordinator;

  beforeEach(() => {
    udp = new MockUdpHub();
    coordinator = new Coordinator();
  });

  afterEach(async () => {
    for (const m of machines) if (m.isRunning()) await m.stop();
    machines.length = 0;
    for (const h of hosts) await h.stop();
    hosts.length = 0;
  });

  /**
   * Start a host server that the test stops at its end.
   * @param port - The port to hold; 0 for a free one.
   * @returns The server.
   */
  const host = async (port = 0): Promise<HostServer> => {
    const h = await hostServer(port);
    hosts.push(h);
    return h;
  };

  /**
   * A machine of the site. Broadcast, cloud poll and probe cycle share one
   * interval, in the proportions of a deployment.
   * @param dir - Its identity directory; the same one keeps its node id.
   * @param port - Its hub port, held by its host server.
   * @param probing - Off, or every cycle without a listener of its own.
   * @returns The machine, not yet started.
   */
  const machine = (
    dir: string,
    port: number,
    probing: 'off' | 'without listener',
  ): NetworkManager => {
    const config: NetworkConfig = {
      domain: 'site',
      port,
      identityDir: dir,
      broadcast: { enabled: true, port: 41234, intervalMs: 200, timeoutMs: 2_000 },
      probing:
        probing === 'off'
          ? { enabled: false }
          : { enabled: true, listen: false, intervalMs: 200, timeoutMs: 500 },
      cloud: {
        enabled: true,
        endpoint: 'http://coordinator.test',
        tenantId: 'tenant',
        pollIntervalMs: 200,
      },
    };
    const m = new NetworkManager(config, {
      broadcastDeps: { createSocket: udp.createSocketFn(), selfTestTimeoutMs: 50 },
      cloudDeps: { createHttpClient: () => coordinator.client() },
    });
    machines.push(m);
    return m;
  };

  const roles = (...ms: NetworkManager[]) =>
    ms.map((m) => m.getTopology().myRole);

  const hubs = (...ms: NetworkManager[]) =>
    roles(...ms).filter((r) => r === 'hub').length;

  // ...........................................................................

  describe('probing off', () => {
    it('makes a machine that joins its running site alone a second hub', async () => {
      // Why `listen: false` exists. Nothing on either machine ever corrects it.
      const a = machine(identityDir(), (await host()).port, 'off');
      await a.start();
      await settle(600);
      expect(roles(a)).toEqual(['hub']);

      const b = machine(identityDir(), (await host()).port, 'off');
      await b.start();
      await settle(1_500);

      expect(roles(a, b)).toEqual(['hub', 'hub']);
    });

    it('heals a lone restart only when the coordinator holds the other direction', async () => {
      // Why restarts looked random: a lone restart heals when the returning
      // machine once reported the hub reachable — in some earlier run, by
      // hearing its broadcast first — and splits when it never did. Machines
      // started together split about every second time on the same race.
      const dirB = identityDir();
      const portB = (await host()).port;
      const a = machine(identityDir(), (await host()).port, 'off');
      await a.start();
      await settle(600);
      const b = machine(dirB, portB, 'off');
      await b.start();
      await settle(800);
      expect(roles(a, b)).toEqual(['hub', 'hub']);

      coordinator.reports.set(
        `${b.getIdentity().nodeId}|${a.getIdentity().nodeId}`,
        true,
      );
      await b.stop();
      await settle(300);
      const b2 = machine(dirB, portB, 'off');
      await b2.start();
      await settle(1_500);

      expect(roles(a, b2)).toEqual(['hub', 'client']);
    });
  });

  // ...........................................................................

  describe('probing every cycle without a listener (`listen: false`)', () => {
    it('hands the hub to the earlier machine when one joins alone', async () => {
      const a = machine(identityDir(), (await host()).port, 'without listener');
      await a.start();
      await settle(600);
      const b = machine(identityDir(), (await host()).port, 'without listener');
      await b.start();
      await settle(1_000);

      expect(roles(a, b)).toEqual(['hub', 'client']);
    });

    it('keeps one hub when both machines start together', async () => {
      // Who hears whom first differs from run to run; the result must not.
      for (let run = 0; run < 3; run++) {
        const a = machine(identityDir(), (await host()).port, 'without listener');
        const b = machine(identityDir(), (await host()).port, 'without listener');
        await Promise.all([a.start(), b.start()]);
        await settle(1_000);

        expect(hubs(a, b)).toBe(1);
        await Promise.all([a.stop(), b.stop()]);
        coordinator = new Coordinator();
      }
    });

    it('keeps one hub when the hub restarts alone', async () => {
      // The hub's machine goes down with its host server, and comes back on
      // the same port and identity while the other machine took over.
      const dirA = identityDir();
      const hostA = await hostServer();
      const a = machine(dirA, hostA.port, 'without listener');
      await a.start();
      await settle(600);
      const b = machine(identityDir(), (await host()).port, 'without listener');
      await b.start();
      await settle(1_000);
      expect(roles(a, b)).toEqual(['hub', 'client']);

      await a.stop();
      await hostA.stop();
      await settle(1_500);
      expect(roles(b)).toEqual(['hub']);

      const a2 = machine(dirA, (await host(hostA.port)).port, 'without listener');
      await a2.start();
      await settle(1_000);

      expect(roles(a2, b)).toEqual(['client', 'hub']);
    });
  });
});
