# Split the yoinks HTTP server into modules with injected state

Bloque 4 of the "more professional and more extensible" plan. `src/server/server.ts` is
998 lines holding ten module-level mutable singletons and eight separate concerns, so
two servers cannot coexist in one process and nothing in it is unit-testable.

## Specs

**S1 — No behaviour change.** The 108 existing tests keep passing without modification.
`startWebServer()` keeps its signature and its `{url, close}` return shape, and every
HTTP response stays byte-identical for the same input.

**S2 — No module-level mutable server state.** Every piece of per-server state
(`probes`, `jobs`, `outDir`, `hosted`, `osHooks`, `cookies`, `yt`, the two rate
limiters, `activeProbes`, `webDir`) lives in one object created by a factory. No
`let` at module scope in any server module.

**S3 — Two servers in one process do not interfere.** Starting a second server must not
change the first one's hosted options, output folder, web folder, rate limits or yt-dlp
pin, and closing either must leave the other's probes and jobs working.

**S4 — `src/server/server.ts` becomes composition and startup**, under roughly 250
lines. Each concern gets its own module under `src/server/`: security, static files,
views, jobs, yt-dlp lifecycle, router.

**S5 — The Electron app keeps its "downloads still running" check** through the
`WebServer` handle it already holds, not through a module-level export.

**S6 — No new dependencies.** `npm run typecheck`, `npm run lint`, `npm test` and
`npm run build` stay green after every task.

## Tasks

| ID | Spec | What | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2, S3, S5 | `src/server/state.ts` factory; thread the state object through every function in `server.ts`; `WebServer` gains `activeDownloads()` so the Electron app stops importing a module-level value; one new test proving two servers do not interfere | worker | uncommitted |
| T2 | S4 | Extract `security.ts` (errors, request checks, auth, limits, body reading) and `static.ts` (MIME, `serveStatic`) | worker | uncommitted |
| T3 | S4 | Extract `views.ts` (probe → client shape) and `jobs.ts` (emit, run, drop, sweep) | worker | uncommitted |
| T4 | S4, S5 | Extract `router.ts` and `ytdlp-setup.ts`; `server.ts` keeps only startup and shutdown; expose `activeDownloads` on the handle | worker | uncommitted |
| T5 | S1 (deliberate exception) | Meter failed password attempts: `checkPassword` consumes `state.authLimiter`, so a guessing loop gets 429 instead of an endless 401. Found while moving the guards in T2 | inline | uncommitted |
| T6 | S2 | Prune the password meter from `sweep` (it takes unauthenticated traffic, so it grew fastest) and turn `hosted.ts`'s module-scope `let` into a read-once constant | inline | uncommitted |

## Log

**L1** — user, original request: "Que se puede mejorar y/o agregar a este proyecto para
que sea mas profesional y extendible flexible?"

**L2** — user, approving block 1: "Bloque 1"

**L3** — user, approving block 2 and the no-split decision: "Hazlo junto y continua con el
siguiente bloque"

**L4** — user, approving block 3: "Continua"

**L5** — user, approving this block: "Si arranca con el bloque 4"

**L6** — decision, why injected state and not just a file split: the verifier found that a
module-wide `shuttingDown` flag made a second live server un-closable, and that closing one
server clears the `probes`/`jobs` maps the other is using. Splitting the file alone would
keep that defect, so the state object comes first.

**L7** — decision, T5: while moving `security.ts` the worker reported that `checkLimits`
sits behind `checkPassword`, so requests that fail basic auth are never metered and a
password-guessing loop is unthrottled in hosted mode. Measured before/after against the
built server: twelve wrong passwords answered `401` every time before, `401`×10 then `429`
after. That is the one intentional behaviour change in this block.

**L8** — scope note: `EXTRA_ARGS` in `src/lib/ytdlp.ts` (the cookies/proxy argv channel) is
still process-wide, so two hosted servers in one process share the last written `--cookies`.
Left for a follow-up: fixing it means threading argv through `probe`/`download`.

**L9** — T6, from the verification of this block: the new password meter was never pruned
(`sweep` pruned only the probe and download meters), so it grew with unauthenticated traffic
from every source address. Also: `handleCookies` is exported from `ytdlp-setup.ts` with only
"a password is configured" as its gate, so it now re-checks the request itself instead of
relying on the router. And `hosted.ts`'s `let config` was the last module-scope `let` in
`src/server/`, which S2 forbids — now a read-once constant.

**L10** — result: `server.ts` 998 → 191 lines, 112 tests (from 108), zero module-scope `let`
in `src/server/`, import graph acyclic, bundle serves the SPA.
