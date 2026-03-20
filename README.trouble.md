<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Trouble shooting

## Table of contents <!-- omit in toc -->

- [Hub election looks correct but clients stay on old hub](#hub-election-looks-correct-but-clients-stay-on-old-hub)
- [Vscode Windows: Debugging is not working](#vscode-windows-debugging-is-not-working)

## Hub election looks correct but clients stay on old hub

Date: 2026-03-20

**Problem:**

NetworkManager correctly emits `hub-changed` when the elected hub changes, but clients in `@rljson/server` stayed connected to the old hub, causing split-brain.

**Root Cause:**

This was NOT a bug in `@rljson/network`. The `hub-changed` event was emitted correctly. The problem was in `@rljson/server`'s Node class which only listened to `role-changed` and ignored `hub-changed`.

**Fix:**

`@rljson/server@0.0.14` — Node now subscribes to both `role-changed` and `hub-changed` events.

**Lesson:**

When debugging topology issues, check both the emitter (`NetworkManager`) and the consumer (`Node`). The event was correct — the listener was missing.

## Vscode Windows: Debugging is not working

Date: 2025-03-08

⚠️ IMPORTANT: On Windows, please check out the repo on drive C. There is a bug
in the VS Code Vitest extension (v1.14.4), which prevents test debugging from
working: <https://github.com/vitest-dev/vscode/issues/548> Please check from
time to time if the issue has been fixed and remove this note once it is
resolved.
