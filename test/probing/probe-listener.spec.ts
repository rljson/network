// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ProbeListener,
  defaultProbeListenerDeps,
} from '../../src/probing/probe-listener';

// .............................................................................

describe('ProbeListener', () => {
  const toStop: ProbeListener[] = [];

  afterEach(async () => {
    while (toStop.length > 0) {
      const l = toStop.pop()!;
      await l.stop();
    }
  });

  // .........................................................................

  describe('start / stop', () => {
    it('binds an ephemeral port when port is 0', async () => {
      const listener = new ProbeListener();
      toStop.push(listener);

      const port = await listener.start(0);

      expect(port).toBeGreaterThan(0);
      expect(listener.isRunning()).toBe(true);
      expect(listener.getPort()).toBe(port);
    });

    it('binds the requested port when non-zero', async () => {
      // First grab an ephemeral port to learn one that is free, then
      // bind a fresh listener to that exact port.
      const probe = new ProbeListener();
      const free = await probe.start(0);
      await probe.stop();

      const listener = new ProbeListener();
      toStop.push(listener);

      const bound = await listener.start(free);
      expect(bound).toBe(free);
    });

    it('isRunning is false before start and after stop', async () => {
      const listener = new ProbeListener();
      expect(listener.isRunning()).toBe(false);
      expect(listener.getPort()).toBeNull();

      await listener.start(0);
      expect(listener.isRunning()).toBe(true);

      await listener.stop();
      expect(listener.isRunning()).toBe(false);
      expect(listener.getPort()).toBeNull();
    });

    it('stop is a no-op when never started', async () => {
      const listener = new ProbeListener();
      await expect(listener.stop()).resolves.toBeUndefined();
    });

    it('rejects when port is already in use', async () => {
      const first = new ProbeListener();
      const port = await first.start(0);
      toStop.push(first);

      const second = new ProbeListener();
      await expect(second.start(port)).rejects.toThrow(/EADDRINUSE/);
    });
  });

  // .........................................................................

  describe('TCP behaviour', () => {
    it('accepts a connection and closes it immediately', async () => {
      const listener = new ProbeListener();
      toStop.push(listener);
      const port = await listener.start(0);

      // Open a real TCP connection — the listener should close it.
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          // Wait for the remote end to close (FIN).
          socket.once('end', () => {
            socket.destroy();
            resolve();
          });
        });
        socket.once('error', reject);
      });
    });
  });

  // .........................................................................

  describe('defaultProbeListenerDeps', () => {
    it('returns deps bound to node:net.createServer', () => {
      const deps = defaultProbeListenerDeps();
      expect(typeof deps.createServer).toBe('function');
    });
  });
});
