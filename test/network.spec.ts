// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { describe, expect, it } from 'vitest';

import { Network } from '../src/network';


describe('Network', () => {
  it('should validate a template', () => {
    const network = Network.example;
    expect(network).toBeDefined();
  });
});
