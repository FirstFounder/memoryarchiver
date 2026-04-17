# Session Summary: Multi-Device Architecture Planning
**Date:** 2026-04-07  
**Repo:** memoryarchiver @ 352c43c

---

## Context

memoryarchiver is a Fastify + React application that accepts .MOV files, encodes
and renames them via ffmpeg, and syncs output to a backup location. It runs on
Synology DS-series NAS hardware. The session addressed how to scale deployment
across multiple devices with differing path conventions and sync requirements.

---

## Devices in Environment

| Device | Role | Notes |
|---|---|---|
| DS220+ (iolo, 192.168.106.6) | Remote | Primary dev target, already deployed |
| DS220+ (second unit) | Remote | Same codebase, different paths |
| DS423+ | Hub | Central repository; will push to remotes + 2 NFS backup sites |
| Ubuntu (Docker) | Remote | Potential future target |

---

## Decisions Made

### 1. Multi-Host Config: One Repo, `.env` Per Host

Forking and branching by device were ruled out. The codebase already loads all
host-specific values from environment variables with fallback defaults in
`backend/src/config.js`. The correct pattern is one `main` branch deployed to
all devices, with a host-local `.env` file (already gitignored) supplying
device-specific values.

### 2. SCRATCH_DIRS Externalized

`SCRATCH_DIRS` in `backend/src/lib/allowedRoots.js` was the only host-specific
value not yet in the env system. It was moved to `config.js` as:

```js
scratchDirs: (process.env.SCRATCH_DIRS ?? 'JNR,MHR,CHR,RAH,GHR')
  .split(',').map(s => s.trim()).filter(Boolean),
```

`allowedRoots.js` updated to read `config.scratchDirs` instead of a hardcoded array.

**Committed:** `feat: externalize SCRATCH_DIRS to env var`

### 3. Hub vs. Remote: DEVICE_ROLE, Not a Branch

The DS423+ hub requires functionality the remotes should never expose: push-sync
to remotes and NFS backup sites, and corresponding UI panels for remote status
and transfer progress. This is new code, not config variation.

Evaluated options:

- **Clone** — ruled out. Bug fixes would require manual porting across repos.
- **Permanent branch per device** — ruled out. Functionally a fork; same
  cherry-picking problem.
- **One repo, `DEVICE_ROLE` env var** — chosen. The hub is a strict superset
  of the remote. Hub-only routes conditionally register on the backend;
  hub-only UI panels conditionally render on the frontend based on a
  `GET /api/config` response.

### 4. Development Sequence Agreed

1. Commit `DEVICE_ROLE` scaffolding to `main` now — gating infrastructure only,
   no hub features. Deploy to all three devices. All behave as remotes.
2. Develop hub sync features on a short-lived feature branch (`feat/hub-sync`).
3. Merge to `main` when stable. Remotes pull the new code; hub-only routes
   are present but never registered when `DEVICE_ROLE=remote`.

**Committed:** `feat: add DEVICE_ROLE scaffolding for hub/remote architecture`

---

## Env Vars Added This Session

| Variable | Default | Purpose |
|---|---|---|
| `SCRATCH_DIRS` | `JNR,MHR,CHR,RAH,GHR` | Comma-separated browseable subdirs under scratch root |
| `DEVICE_ROLE` | `remote` | `remote` or `hub` — gates hub-only features |
| `PUSH_TARGETS` | *(empty)* | Comma-separated rsync targets for hub push (hub only) |
| `NFS_DESTINATIONS` | *(empty)* | Comma-separated NFS backup destinations (hub only) |

---

## Files Changed This Session

| File | Change |
|---|---|
| `backend/src/config.js` | Added `scratchDirs`, `deviceRole`, `pushTargets`, `nfsDestinations` |
| `backend/src/lib/allowedRoots.js` | `SCRATCH_DIRS` now reads from `config.scratchDirs` |
| `backend/src/server.js` | Conditional hub route block added; role logged on startup |
| `backend/src/routes/appConfig.js` | New — `GET /api/config` exposes role and path config to frontend |
| `frontend/src/App.jsx` | Fetches `/api/config` on load; placeholder comment for hub panels |

---

## Next Steps

- [ ] Create `.env` files on DS220+ #2 and DS423+ with appropriate path values
- [ ] Open `feat/hub-sync` branch and begin hub push-sync route development
- [ ] Design hub UI panels: remote status indicators, per-destination transfer progress
- [ ] Add Docker support: `Dockerfile`, `docker-compose.yml` with `env_file:` pattern
