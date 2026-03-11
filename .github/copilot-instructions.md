# Copilot Instructions for @rljson/network

## Project Overview

`@rljson/network` is a self-organizing network topology layer for the RLJSON ecosystem. It handles peer discovery, hub election, and topology formation — enabling nodes to automatically form star-topology networks without pre-assigned roles or hardcoded IPs.

**Design document**: `doc/network-strategy.md` in the `ds_serverless_client_server` repo contains the full architecture.

### Critical Design Principle: Zero RLJSON Knowledge

The network package knows **nothing** about Io, Bs, Db, trees, hashes, or sync. It only knows about nodes, peers, and topology. This makes it reusable for any application that needs self-organizing star topology (chat, IoT, game lobbies, etc.).

- Use `domain` (network grouping), **never** `treeKey` (RLJSON concept)
- No imports from `@rljson/io`, `@rljson/bs`, `@rljson/db`, `@rljson/server`, or `@rljson/fs-agent`
- The `Node` class that bridges network → RLJSON lives in `@rljson/server`, not here

### Key Concepts

| Concept              | Field/Class                | Purpose                                                         |
| -------------------- | -------------------------- | --------------------------------------------------------------- |
| **Domain**           | `domain: string`           | Groups nodes that should discover each other. NOT a DNS domain. |
| **Discovery Layer**  | `DiscoveryLayer` interface | Pluggable peer discovery mechanism                              |
| **Fallback Cascade** | Broadcast → Cloud → Static | Layers tried in order of autonomy                               |
| **Manual Override**  | `ManualLayer`              | Always present, always available, cannot be disabled            |
| **Hub Election**     | `HubElection.elect()`      | Incumbent advantage + earliest `startedAt`                      |
| **Network Manager**  | `NetworkManager`           | Central orchestrator: cascade + events                          |

### Architecture: Fallback Cascade

| Position     | Layer         | Required?          | Description                                            |
| ------------ | ------------- | ------------------ | ------------------------------------------------------ |
| **Try 1**    | UDP Broadcast | **always on**      | Zero-config LAN discovery. Primary path.               |
| **Try 2**    | Cloud Service | **optional**       | Cross-network fallback. Must be explicitly configured. |
| **Try 3**    | Static Config | **optional**       | Hardcoded `hubAddress`. Last resort.                   |
| **Override** | Manual / UI   | **always present** | Human escape hatch. No config entry — always built-in. |

### Hub Election Rules

1. **Incumbent advantage**: If there is already a hub and it's still reachable, keep it.
2. **Earliest `startedAt`**: If no incumbent, the node with the earliest startup timestamp wins.
3. **Tiebreaker**: Lexicographic `nodeId` comparison (astronomically rare).

### Flap Dampening

ProbeScheduler uses consecutive failure counting to prevent flapping:

- A peer must fail `failThreshold` consecutive probes (default: 3) before
  being declared unreachable
- A single success resets the counter immediately
- First probe establishes baseline — never triggers events
- The `FormedBy` type includes `'broadcast'` when broadcast layer is active
  with peers, and `'election'` otherwise

### Target Module Structure

```
src/
├── types/
│   ├── node-info.ts            // NodeInfo, NodeId
│   ├── peer-probe.ts           // PeerProbe
│   ├── network-topology.ts     // NetworkTopology, NodeRole
│   ├── network-config.ts       // NetworkConfig
│   └── network-events.ts       // Event type definitions
├── identity/
│   └── node-identity.ts        // Persistent UUID, hostname, IP discovery
├── election/
│   └── hub-election.ts         // Deterministic hub election (pure function)
├── probing/
│   ├── peer-prober.ts          // Real TCP connect probe via node:net
│   └── probe-scheduler.ts      // Periodic probing + change detection
├── layers/
│   ├── discovery-layer.ts      // Interface
│   ├── broadcast-layer.ts      // Try 1: UDP broadcast discovery
│   ├── cloud-layer.ts          // Try 2: REST API (not yet implemented)
│   ├── static-layer.ts         // Try 3: config file
│   └── manual-layer.ts         // Override: programmatic API
├── peer-table.ts               // Merged view of all peers
├── network-manager.ts          // Main orchestrator
├── example.ts                  // Runnable example
└── index.ts                    // Public API exports
```

## Coverage Requirements

- **All metrics MUST be 100%**: Statements, Branches, Functions, Lines
- Coverage validation runs automatically in `pnpm test`
- Build fails if any metric drops below 100%

**MANDATORY: Vitest 4.0 Ignore Patterns (ast-v8-to-istanbul)**

Since Vitest 4.0, coverage uses `ast-v8-to-istanbul` which supports **semantic** ignore hints.
**ALWAYS use semantic hints. NEVER use the old `next N` line-counting pattern.**

All comments MUST include `-- @preserve` to survive esbuild transpilation.

**Allowed patterns:**

| Pattern                                                                      | Meaning                              |
| ---------------------------------------------------------------------------- | ------------------------------------ |
| `/* v8 ignore if -- @preserve */`                                            | Ignore the if-branch                 |
| `/* v8 ignore else -- @preserve */`                                          | Ignore the else-branch               |
| `/* v8 ignore next -- @preserve */`                                          | Ignore the next statement/expression |
| `/* v8 ignore file -- @preserve */`                                          | Ignore the entire file               |
| `/* v8 ignore start -- @preserve */` ... `/* v8 ignore stop -- @preserve */` | Ignore a range of lines              |

**FORBIDDEN patterns (NEVER use):**

```typescript
// ❌ WRONG: Line counting — fragile, breaks on refactoring
/* v8 ignore next 3 -- @preserve */
/* v8 ignore next 5 -- @preserve */

// ❌ WRONG: Missing @preserve — esbuild strips the comment
/* v8 ignore next */
/* v8 ignore start */

// ❌ WRONG: 'end' instead of 'stop'
/* v8 ignore end */
```

**Correct examples:**

```typescript
// Defensive null check — use 'if' to ignore the entire if-block
/* v8 ignore if -- @preserve */
if (!peer) {
  continue;
}

// Error catch blocks — use 'start'/'stop' for multi-line ranges
try {
  result = await prober.probe(host, port, timeout);
} catch {
  /* v8 ignore start -- @preserve */
  // Defensive fallback
  continue;
}
/* v8 ignore stop -- @preserve */
```

**Invalid use of v8 ignore**: Do not use to avoid writing tests for reachable code.

## Package Manager

Uses **pnpm**. Never modify the `scripts` section in `package.json` without explicit user permission.

## Pre-Commit Checklist (MANDATORY — NEVER SKIP)

**Before EVERY commit, run these checks IN ORDER. No exceptions.**

1. **Update READMEs FIRST** — When adding or changing public API, features, or behavior, update the relevant README files (README.public.md, README.architecture.md, copilot-instructions.md, etc.) **BEFORE** proposing a commit. A feature is NOT complete until its documentation matches. This is the FIRST step, not the last.
2. **Check for TypeScript / lint errors** in every file you touched (use the IDE error checker)
3. **Run `pnpm exec eslint <changed-files>`** to catch lint violations
4. **Run `pnpm test`** to verify tests pass and coverage stays at 100%
5. **Fix all errors before moving on** — never leave red squiggles behind

This applies to source files AND test files. A change is not complete until all diagnostics are clean.

## Git Workflow (MANDATORY)

- **NEVER commit directly to `main`.** Always work on a feature branch.
- When proposing commits, provide a commit message, wait for user approval, then commit.
- **GitKraken MCP tools** (`mcp_gitkraken_git_status`, `mcp_gitkraken_git_add_or_commit`, etc.) may timeout in large workspaces. **Always use `run_in_terminal` with raw git commands** (e.g., `git status --short`, `git add .`, `git commit -am"..."`) instead.
- **`pnpm link` is acceptable** during development for local cross-repo dependencies.
- **Before PR/merge**: unlink all local overrides (`git restore package.json pnpm-lock.yaml`, remove `pnpm.overrides`), verify tests still pass with published versions.

### Repository scripts

All git workflow operations **MUST** use the scripts in `scripts/`. Never use raw git commands for these operations.

| Step | Script                                          | Purpose                                                    |
| ---- | ----------------------------------------------- | ---------------------------------------------------------- |
| 1    | `node scripts/create-branch.js "<description>"` | Create a kebab-case feature branch                         |
| 2    | `node scripts/push-branch.js`                   | Push the feature branch (guards against pushing to `main`) |
| 3    | `node scripts/wait-for-pr.js`                   | Poll PR status until merged/closed                         |
| 4    | `node scripts/delete-feature-branch.js`         | Switch to `main`, pull, verify merge, delete local branch  |
| 5    | `node scripts/add-version-tag.js`               | Create and push a `v<version>` git tag                     |
| 6    | `node scripts/is-clean-repo.js`                 | Check if repo is clean and on up-to-date `main`            |

## Publish Workflow (MANDATORY)

All `@rljson/*` packages share the same publish workflow documented in `doc/develop.md` (or `doc/workflows/develop.md`). **Follow these steps in exact order:**

### Pre-publish checklist

1. **Unlink local overrides** — Remove all `pnpm.overrides` entries that use `link:../...` and restore `package.json` and `pnpm-lock.yaml` to use published versions:
   ```bash
   # Remove overrides from package.json (set "overrides": {})
   # Then reinstall to get published versions:
   pnpm install
   ```
2. **Run tests with published deps** — `pnpm test` must pass with 100% coverage using published (not linked) dependencies.
3. **Rebuild** — `pnpm run build` (which runs tests via `prebuild`).
4. **Increase version** — `pnpm version patch --no-git-tag-version` then `git commit -am"Increase version"`.
5. **Commit ALL files** — including `package.json` and `pnpm-lock.yaml`. Nothing should be left uncommitted.

### Merge & publish steps

```bash
git rebase main
node scripts/push-branch.js
gh pr create --base main --title "<PR title>" --body " "
gh pr merge --auto --squash
node scripts/wait-for-pr.js
node scripts/delete-feature-branch.js
git checkout main && git pull
pnpm login
pnpm publish
```

**CRITICAL: Always use exactly `pnpm publish` — no flags, no piping.**

```bash
# ✅ CORRECT
pnpm publish

# ❌ WRONG — never add flags or pipe output
pnpm publish --no-git-checks
pnpm publish 2>&1 | tail -15
```

### Cross-repo publish order

Packages MUST be published bottom-up by dependency order. A downstream package can only be published after its upstream dependency is on npm.

| Order | Package            | Depends on                                                                    |
| ----- | ------------------ | ----------------------------------------------------------------------------- |
| 1     | `@rljson/rljson`   | — (Layer 0, no `@rljson` deps)                                                |
| 1     | `@rljson/network`  | — (Layer 0, no `@rljson` deps, parallel with rljson)                          |
| 2     | `@rljson/io`       | `@rljson/rljson`                                                              |
| 3     | `@rljson/bs`       | `@rljson/rljson`, `@rljson/io`                                                |
| 3     | `@rljson/db`       | `@rljson/rljson`, `@rljson/io`                                                |
| 4     | `@rljson/server`   | `@rljson/rljson`, `@rljson/io`, `@rljson/bs`, `@rljson/db`, `@rljson/network` |
| 5     | `@rljson/fs-agent` | all of the above                                                              |

After publishing an upstream package, downstream packages must `pnpm update --latest` to pick up the new version before their own publish.

## Dependency Pinning (MANDATORY)

- **ESLint**: Pin to `~9.39.2`. ESLint 10+ breaks the build. Never allow `pnpm update --latest` to bump eslint beyond 9.x.

  ```jsonc
  // ✅ CORRECT
  "eslint": "~9.39.2"

  // ❌ WRONG — will pull in v10 which breaks everything
  "eslint": "^10.0.0"
  ```

- After running `pnpm update --latest`, **always verify** eslint stayed on 9.x: `pnpm ls eslint`.

- **TypeScript**: ESM modules (`"type": "module"`)
- **Node version**: >=22.14.0
- **License headers**: Required in all source files
- **Test framework**: Vitest with `describe()`, `it()`, `expect()`

## Testing

- **Run all tests**: `pnpm test` (also runs lint)
- **Build** (includes tests): `pnpm run build`
- **Update golden files**: `pnpm updateGoldens` (sets `UPDATE_GOLDENS=true`, reruns tests)
- **Debug tests in VS Code**: Open test file → set breakpoint → Alt+click play button in Test Explorer
