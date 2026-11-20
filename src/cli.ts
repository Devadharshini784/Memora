#!/usr/bin/env bun
/**
 * memora CLI — local introspection + MCP launcher.
 *
 * Subcommands, grouped by who runs them:
 *
 *   Humans poking at the DB:
 *     init / verify / stats / ls / show / handoffs
 *     recall / remember / handoff / resolve / link / assess / eval
 *     orient                    The packet a session start would inject
 *     touching / anchors        Memory by file, and whether its code moved
 *     forget-session            Scoped, confirmation-gated cleanup
 *
 *   Agent clients:
 *     mcp                       MCP server over stdio
 *
 *   Harnesses, not people:
 *     install <harness>         Wire session hooks into harness settings
 *     session start|checkpoint|end
 *                               Lifecycle phases; hook payload on stdin
 *
 * The `session` commands are the one part of the CLI written for a machine
 * caller: they read JSON on stdin, and they never exit non-zero for a
 * runtime problem, because a failing hook degrades somebody's session.
 *
 * memora deliberately does NOT write a SKILL.md. The MCP tool descriptions
 * are the spec the agent works from. Bullets in a markdown file are
 * decaying prompts; the tool is the prompt.
 */

import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { memora, Sharedmemora, defaultDbPath, driftIsSuspect, rollupDrift } from "./index.ts";
import { formatDoctorReport, formatDuplicateSuggestion, formatOrientation, formatTouching } from "./format.ts";
import { buildDoctorReport } from "./doctor.ts";
import {
  checkpoint,
  claudeCodeHooks,
  describePreserve,
  finish,
  mergeHooks,
  orient,
  parseHarnessEvent,
  unmergeHooks,
} from "./harness.ts";
import { currentSessionId } from "./lifecycle.ts";
import { readSessionPointer } from "./session.ts";
import { changedPaths } from "./worktree.ts";
import { agreement, replay } from "./replay.ts";

function usage(): never {
  console.log(`memora — local-first agent memory

Usage:
  memora as <author> <command...>  Run a command as an agent identity
  memora init                  Create the DB + print MCP wiring snippet
  memora mcp                   Run the MCP server (stdio — for agent clients)
  memora verify                Check schema, SQLite integrity, and FTS coverage
  memora doctor [--json]       Redacted diagnostic bundle: db health, every
                               scope's counts, current-scope anchors, session
  memora recall [query] [--tokens=N] [--kind=decision,pitfall]
  memora remember <text> [--keep] [--kind=decision] [--anchor=src/a.ts:42#fn]
  memora orient [--tokens=N] [--limit=N]
                               Show the packet a new session would open with
  memora touching <path...>     Memory anchored to these files
  memora touching --diff        Memory anchored to your uncommitted changes
  memora anchors [--drifted]    Anchored memory and whether its code moved
  memora handoff <summary>     Leave one active handoff for this session
  memora resolve <id> [completed|abandoned]
  memora link <from> <supersedes|contradicts|related> <to>
  memora assess <trace> <useful|wrong|missed|no_memory_needed> [note]
  memora eval                  Show scoped recall-quality evidence
  memora eval --replay [--json] [--limit=N]
                               Re-run recorded retrievals against today's code
  memora forget-session <id> --yes  Expire a session's scoped slips
  memora install claude-code [--global] [--print] [--uninstall]
                               Wire session hooks into Claude Code settings
  memora session start [--harness=claude-code] [--no-worktree]
                               Orient a new session (reads hook JSON on stdin)
  memora session checkpoint    Preserve this session's work before compaction
  memora session end           Preserve, then release the session claim
  memora ls [--session]        List kept slips (or current session's slips)
  memora show <id>             Show a slip + its links
  memora stats                 Print counts and DB path
  memora handoffs              List recent handoffs
  memora send <to> <message>   Send async mailbox message
  memora inbox [to]            Read unread mailbox messages
  memora read <id>             Mark message read
  memora reply <id> <message>  Reply to a message
  memora shared status          Check shared local copy/current state
  memora shared recall <query>  Search shared local copy
  memora shared remember <text> Save shared memory
  memora shared handoff <text>  Leave shared handoff
  memora shared signal <id> <used|wrong|forget>
  memora shared delete <id>     Delete shared memory content locally + from server replay
  memora shared mcp             Run shared MCP server

Env:
  memora_AUTHOR    Identity recorded with new slips (default: unknown-agent)
  memora_SESSION   Override session id (default: derived per-process)
  memora_DB        Override DB path (default: ~/.memora/memora.db)
  memora_SCOPE     Override automatic git-repository scope (use global deliberately)
  memora_INCLUDE_LEGACY  Set to 1 to search pre-scope rows during migration
  memora_SHARED_GATEWAY  Shared memory server URL (required for shared commands)
  memora_SHARED_TOKEN    Bearer token for the shared memory server
  memora_SHARED_MIRROR_DB Local searchable shared-copy DB path (optional)
`);
  process.exit(1);
}

function dbPath(): string {
  return process.env.memora_DB ?? defaultDbPath();
}

function author(): string {
  return process.env.memora_AUTHOR ?? "unknown-agent";
}

function fmtSlip(s: ReturnType<memora["get"]> & object): string {
  const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
  const state = s.state.padEnd(7);
  const date = new Date(s.createdAt).toISOString().slice(0, 19);
  return `${s.id}  ${state}  ${date}  ${s.authoredBy}${tags}\n  scope: ${s.scope}\n  ${s.text.replace(/\n/g, "\n  ")}`;
}

async function cmdInit(): Promise<void> {
  const path = dbPath();
  const d = new memora({ path });
  d.close();
  console.log(`memora: db ready at ${path}`);

  console.log(`
Wire memora into your MCP client. Tool descriptions are the spec — no SKILL.md, no AGENTS.md.

If you ran this via 'bunx @Devadharshini784/memora init', the MCP server is reachable
the same way: 'bunx @Devadharshini784/memora mcp'. If you cloned, use the local path.

Claude Code (~/.config/claude-code/mcp.json):

  {
    "mcpServers": {
      "memora": {
        "command": "bunx",
        "args": ["@Devadharshini784/memora", "mcp"]
      }
    }
  }

OpenCode (~/.config/opencode/opencode.jsonc):

  "mcp": {
    "memora": {
      "type": "local",
      "command": ["bunx", "@Devadharshini784/memora", "mcp"]
    }
  }

pi (~/.pi/agent/mcp.json):

  {
    "mcpServers": {
      "memora": {
        "command": "bunx",
        "args": ["@Devadharshini784/memora", "mcp"]
      }
    }
  }

(Cloned the repo instead? Replace 'bunx @Devadharshini784/memora' with
 'bun run ${import.meta.dir}/cli.ts' in any of the above.)
`);
}

function cmdVerify(): void {
  const path = dbPath();
  const exists = existsSync(path);
  console.log(`db:    ${path} ${exists ? "OK" : "MISSING"}`);
  if (!exists) process.exit(1);

  const d = new memora({ path, skipGc: true });
  const health = d.storage.health();
  const c = d.counts();
  console.log(`scope: ${d.scope}`);
  console.log(`sqlite: ${health.sqlite}`);
  console.log(`fts: ${health.indexed}/${health.slips} indexed`);
  console.log(`slips: ${c.slips} (${c.kept} kept, ${c.drafts} draft)`);
  console.log(`handoffs: ${c.handoffs}`);
  console.log(`messages: ${c.messages} (${c.pending} pending)`);
  const claimed = readSessionPointer(d.scope, { dbPath: path });
  d.close();
  console.log(`session: ${claimed ? `${claimed.sessionId} (claimed by ${claimed.harness})` : currentSessionId()}`);
  if (!health.ok) process.exit(1);
}

/**
 * A superset of `memora verify`, built to be pasted into a bug report:
 * db health, every repository scope this database has memory from (not
 * just the current one), current-scope anchor drift, session-pointer
 * state, and runtime info. Redacted by construction — see
 * `src/doctor.ts` — so there is nothing here for a maintainer fielding
 * an issue to have to ask the reporter to strip out.
 */
function cmdDoctor(args: string[]): void {
  const path = dbPath();
  if (!existsSync(path)) {
    console.error(`db: ${path} MISSING`);
    process.exit(1);
  }
  const d = new memora({ path, skipGc: true });
  try {
    const report = buildDoctorReport(d);
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
  } finally {
    d.close();
  }
}

function cmdRecall(args: string[]): void {
  const maxTokens = Number(args.find((arg) => arg.startsWith("--tokens="))?.split("=")[1] ?? 1200);
  const kindArg = args.find((arg) => arg.startsWith("--kind="))?.split("=")[1];
  const kinds = kindArg ? kindArg.split(",") as import("./types.ts").MemoryKind[] : undefined;
  const query = args.filter((arg) => !arg.startsWith("--tokens=") && !arg.startsWith("--kind=")).join(" ").trim();
  const d = new memora({ path: dbPath(), skipGc: true });
  const r = d.recall(query, { limit: 10, maxTokens, kinds });
  console.log(`receipt: ${r.traceId}`);
  if (r.activeHandoff) {
    console.log(`-- active handoff (${r.activeHandoff.scope}) --`);
    console.log(`  ${r.activeHandoff.summary}`);
    if (r.activeHandoff.next.length > 0) {
      console.log(`  next:`);
      for (const n of r.activeHandoff.next) console.log(`    - ${n}`);
    }
    console.log();
  }
  if (r.hits.length === 0) {
    console.log(query ? `(no hits for "${query}")` : "(no recent scoped memory)");
  } else {
    for (const h of r.hits) {
      console.log(`[${h.trust}] ${fmtSlip(h.slip)}`);
      console.log();
    }
  }
  d.close();
}

function cmdRemember(args: string[]): void {
  const keep = args.includes("--keep");
  const kindArg = args.find((arg) => arg.startsWith("--kind="))?.split("=")[1] as import("./types.ts").MemoryKind | undefined;
  const anchors = args
    .filter((arg) => arg.startsWith("--anchor="))
    .map((arg) => arg.slice("--anchor=".length))
    .filter((value) => value.length > 0);
  const text = args
    .filter((arg) => arg !== "--keep" && !arg.startsWith("--kind=") && !arg.startsWith("--anchor="))
    .join(" ")
    .trim();
  if (!text) throw new Error("usage: memora remember <text> [--keep] [--kind=decision] [--anchor=path:line#symbol]");
  const d = new memora({ path: dbPath(), skipGc: true });
  try {
    // Checked before the write, so the new slip can never match itself.
    const duplicate = d.findDuplicate(text);
    const slip = d.remember(text, { kind: kindArg, anchors });
    if (keep) d.keep([slip.id]);
    console.log(`${keep ? "kept" : "drafted"} ${slip.kind} ${slip.id} in ${slip.scope}`);
    for (const anchor of d.anchorsFor(slip.id)) {
      console.log(`  anchored to ${anchor.path}@${anchor.blobSha.slice(0, 8)}`);
    }
    if (duplicate) {
      console.log(`  ${formatDuplicateSuggestion(duplicate)}`);
      console.log(`  link it: memora link ${slip.id} supersedes ${duplicate.slip.id}`);
    }
  } finally {
    d.close();
  }
}

/**
 * Repository-relative paths of the working tree's uncommitted changes.
 *
 * The shared helper reports "could not read the diff" as null so a
 * session hook can shrug it off; a human who typed `--diff` explicitly
 * deserves to be told instead.
 */
function diffPaths(root: string): string[] {
  const paths = changedPaths(root);
  if (paths === null) {
    throw new Error("memora touching --diff: could not read the diff (is this a git checkout with commits?)");
  }
  return paths;
}

/**
 * Show the packet a session would open with, right now.
 *
 * The same composition a `SessionStart` hook injects, printed for the
 * person rather than the agent. Without this the only way to see what an
 * agent is actually being handed is to simulate a hook, which makes a
 * packet that is quietly wrong very hard to notice.
 */
function cmdOrient(args: string[]): void {
  const maxTokens = Number(args.find((arg) => arg.startsWith("--tokens="))?.split("=")[1] ?? 700);
  const limit = Number(args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ?? 6);
  const d = new memora({ path: dbPath(), skipGc: true });
  try {
    console.log(formatOrientation(d.orientation({ maxTokens, limit }), d.storage));
  } finally {
    d.close();
  }
}

function cmdTouching(args: string[]): void {
  const d = new memora({ path: dbPath(), skipGc: true });
  try {
    const paths = args.includes("--diff")
      ? diffPaths(d.anchorRoot)
      : args.filter((arg) => !arg.startsWith("--"));
    if (paths.length === 0) {
      console.log(
        args.includes("--diff")
          ? "(no uncommitted changes)"
          : "usage: memora touching <path...> | memora touching --diff",
      );
      return;
    }
    console.log(formatTouching(d.touching(paths), d.storage));
  } finally {
    d.close();
  }
}

function cmdAnchors(args: string[]): void {
  const onlyDrifted = args.includes("--drifted");
  const d = new memora({ path: dbPath(), skipGc: true });
  try {
    const slips = d.storage.listAnchoredSlips(d.scope, d.options.includeLegacy);
    const tally = { verified: 0, drifted: 0, orphaned: 0, unknown: 0 };
    let shown = 0;

    for (const slip of slips) {
      const states = d.anchorStates(slip.id);
      const drift = rollupDrift(states);
      if (drift) tally[drift] += 1;
      if (onlyDrifted && !driftIsSuspect(drift)) continue;
      shown += 1;
      console.log(`${slip.id}  ${slip.kind.padEnd(10)}  ${drift ?? "unanchored"}`);
      console.log(`  ${slip.text.replace(/\n/g, "\n  ")}`);
      for (const state of states) console.log(`  ${state.detail}`);
      console.log();
    }

    if (shown === 0) {
      console.log(onlyDrifted ? "(no anchored memory has drifted)" : "(no anchored memory in this scope)");
    }
    console.log(
      `scope: ${d.scope}\nanchored: ${slips.length}  verified: ${tally.verified}  drifted: ${tally.drifted}  orphaned: ${tally.orphaned}  unknown: ${tally.unknown}`,
    );
  } finally {
    d.close();
  }
}

function cmdWriteHandoff(args: string[]): void {
  const summary = args.join(" ").trim();
  if (!summary) throw new Error("usage: memora handoff <summary>");
  const d = new memora({ path: dbPath(), skipGc: true });
  const handoff = d.handoff({ summary });
  console.log(`active handoff ${handoff.id} (${handoff.kept.length} slip(s) kept)`);
  d.close();
}

function cmdResolve(args: string[]): void {
  const id = args[0];
  const status = (args[1] ?? "completed") as "completed" | "abandoned";
  if (!id || !["completed", "abandoned"].includes(status)) throw new Error("usage: memora resolve <id> [completed|abandoned]");
  const d = new memora({ path: dbPath(), skipGc: true });
  if (!d.resolveHandoff(id, status)) throw new Error(`active handoff ${id} not found`);
  console.log(`handoff ${id}: ${status}`);
  d.close();
}

function cmdLink(args: string[]): void {
  const [from, kind, to] = args as [string | undefined, import("./types.ts").LinkKind | undefined, string | undefined];
  if (!from || !to || !kind || !["supersedes", "contradicts", "related"].includes(kind)) throw new Error("usage: memora link <from> <supersedes|contradicts|related> <to>");
  const d = new memora({ path: dbPath(), skipGc: true });
  if (!d.link(from, to, kind)) throw new Error("both slips must exist in the current repository scope");
  console.log(`linked ${from} ${kind} ${to}`);
  d.close();
}

function cmdAssess(args: string[]): void {
  const [traceId, assessment, ...noteParts] = args as [string | undefined, import("./types.ts").RecallAssessment | undefined, ...string[]];
  if (!traceId || !assessment || !["useful", "wrong", "missed", "no_memory_needed"].includes(assessment)) throw new Error("usage: memora assess <trace> <useful|wrong|missed|no_memory_needed> [note]");
  const d = new memora({ path: dbPath(), skipGc: true });
  if (!d.assessRecall(traceId, assessment, noteParts.join(" "))) throw new Error(`recall trace ${traceId} not found`);
  console.log(`recall ${traceId}: ${assessment}`);
  d.close();
}

function cmdEval(args: string[] = []): void {
  const d = new memora({ path: dbPath(), skipGc: true });
  try {
    if (args.includes("--replay")) {
      cmdEvalReplay(d, args);
      return;
    }
    const report = d.recallReport();
    console.log(`scope: ${d.scope}`);
    console.log(`recalls: ${report.total}`);
    console.log(`assessed: ${report.assessed}`);
    console.log(`  useful: ${report.useful}`);
    console.log(`  wrong: ${report.wrong}`);
    console.log(`  missed: ${report.missed}`);
    console.log(`  no memory needed: ${report.noMemoryNeeded}`);
    const actionable = report.useful + report.wrong + report.missed;
    if (actionable > 0) console.log(`useful share of actionable recalls: ${((report.useful / actionable) * 100).toFixed(1)}%`);
    if (report.total > 0) console.log(`\n(memora eval --replay re-runs these against today's retrieval)`);
  } finally {
    d.close();
  }
}

/**
 * Re-run recorded retrievals and report what moved.
 *
 * The closing note is not decoration. The number this prints is easy to
 * read as a grade, and it is not one: an intentional retrieval
 * improvement lands here as `changed`, exactly like a regression does.
 * Saying so next to the number is cheaper than explaining it afterwards.
 */
function cmdEvalReplay(d: memora, args: string[]): void {
  const limit = args.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
  const report = replay(d, limit ? { limit: Number(limit) } : {});

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`scope: ${report.scope}`);
  console.log(`replayed ${report.traces} receipt(s) as of when each was served`);
  if (report.traces === 0) {
    console.log(`\n(nothing recorded yet — retrievals in this repository leave the receipts this replays)`);
    return;
  }

  const pad = (value: string, width: number) => value.padEnd(width);
  const num = (value: number, width: number) => String(value).padStart(width);
  console.log();
  console.log(`${pad("tier", 14)}replayed  identical  reordered  changed`);
  console.log("-".repeat(52));
  for (const [name, summary] of [["exact", report.exact], ["approximate", report.approximate]] as const) {
    if (summary.replayed === 0) continue;
    console.log(
      pad(name, 14) +
        num(summary.replayed, 8) +
        num(summary.identical, 11) +
        // Order is not compared in the approximate tier, so a zero there
        // would read as "nothing was reordered" rather than "not checked".
        (name === "approximate" ? "          –" : num(summary.reordered, 11)) +
        num(summary.changed, 9),
    );
  }
  if (report.skipped > 0) console.log(`skipped: ${report.skipped}`);

  const exact = agreement(report.exact);
  const approximate = agreement(report.approximate);
  const parts: string[] = [];
  if (exact !== null) parts.push(`exact ${exact.toFixed(1)}%`);
  if (approximate !== null) parts.push(`approximate ${approximate.toFixed(1)}%`);
  if (parts.length > 0) console.log(`\nagreement with what was served: ${parts.join(", ")}`);

  const changed = report.cases.filter((c) => c.verdict === "changed" || c.verdict === "skipped");
  if (changed.length > 0) {
    console.log(`\nmoved:`);
    for (const item of changed.slice(0, 20)) {
      const label = item.query.length > 44 ? `${item.query.slice(0, 43)}…` : item.query;
      const delta = item.verdict === "skipped"
        ? `skipped (${item.reason ?? "unknown"})`
        : `+${item.gained.length} -${item.lost.length}`;
      console.log(`  ${item.traceId}  ${pad(item.kind, 12)}${pad(`"${label}"`, 46)}${delta}`);
    }
    if (changed.length > 20) console.log(`  … and ${changed.length - 20} more`);
  }

  if (report.assessed.total > 0) {
    console.log(
      `\nassessed at the time: ${report.assessed.total} ` +
        `(useful ${report.assessed.useful}, wrong ${report.assessed.wrong}, missed ${report.assessed.missed})`,
    );
  }

  console.log(
    `\nReplay measures stability and coverage, not truth. A difference is not
automatically a regression — an intentional retrieval improvement lands
here as "changed" too. To check a change you are making, compare
'memora eval --replay --json' before and after it.`,
  );
  if (report.approximate.replayed > 0) {
    console.log(
      `Orientation packets replay approximately: they are ordered by evidence
counters, which have no history and cannot be restored.`,
    );
  }
}

function cmdForgetSession(args: string[]): void {
  const sessionId = args.find((arg) => arg !== "--yes");
  if (!sessionId || !args.includes("--yes")) throw new Error("usage: memora forget-session <id> --yes");
  const d = new memora({ path: dbPath(), skipGc: true });
  console.log(`expired ${d.forgetSession(sessionId)} slip(s) from ${sessionId} in ${d.scope}`);
  d.close();
}

/**
 * Wire memora's session hooks into a harness's settings file.
 *
 * Writing into somebody else's configuration deserves care, so this
 * refuses to touch a file it cannot parse, preserves every hook it did
 * not put there, replaces a previous memora install rather than stacking
 * a second copy, supports --print for a dry run, and can uninstall.
 */
function cmdInstall(args: string[]): void {
  const target = args[0];
  if (target !== "claude-code") {
    console.error("usage: memora install claude-code [--global] [--print] [--uninstall]");
    process.exit(1);
  }
  const global = args.includes("--global");
  const settingsPath = global
    ? join(homedir(), ".claude", "settings.json")
    : join(process.cwd(), ".claude", "settings.json");

  // Reflect however this CLI was actually invoked, so a clone wires the
  // clone and an installed copy wires the installed copy.
  const command = process.env.memora_COMMAND ?? `bun run ${join(import.meta.dir, "cli.ts")}`;

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      console.error(
        `memora install: ${settingsPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
      );
      console.error("Refusing to overwrite it. Fix or move the file and re-run.");
      process.exit(1);
    }
  }

  const next = args.includes("--uninstall")
    ? unmergeHooks(settings)
    : mergeHooks(settings, claudeCodeHooks(command));
  const rendered = `${JSON.stringify(next, null, 2)}\n`;

  if (args.includes("--print")) {
    console.log(rendered);
    return;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, rendered);

  if (args.includes("--uninstall")) {
    console.log(`memora: removed session hooks from ${settingsPath}`);
    return;
  }
  console.log(`memora: session hooks written to ${settingsPath}`);
  console.log(`  SessionStart  → orientation packet (also fires after compaction)`);
  console.log(`  PreCompact    → keep this session's drafts before context is lost`);
  console.log(`  SessionEnd    → keep drafts, roll up a handoff, release the session`);
  console.log(`\nUsing: ${command}`);
  console.log(`Set memora_COMMAND to override, or re-run with --print to inspect first.`);
}

/**
 * Session lifecycle, driven by a harness hook.
 *
 * The hook payload arrives as JSON on stdin. Every phase is written to be
 * unfailing: a hook that exits non-zero or throws degrades the user's
 * session, which is a far worse outcome than missing one memory packet.
 * So the whole body is wrapped, and any error becomes a quiet note on
 * stderr with a zero exit.
 *
 * Output shape differs per phase because harnesses consume them
 * differently. `start` writes the memory packet to stdout, which Claude
 * Code adds to the agent's context on a zero exit. `checkpoint` and `end`
 * have no context channel, so they emit a JSON `systemMessage` for the
 * human instead.
 */
async function cmdSession(args: string[]): Promise<void> {
  const phase = args[0] as import("./harness.ts").HarnessPhase | undefined;
  if (!phase || !["start", "checkpoint", "end"].includes(phase)) {
    console.error(
      "usage: memora session <start|checkpoint|end> [--harness=name] [--tokens=N] [--no-worktree]",
    );
    process.exit(1);
  }
  const rest = args.slice(1);
  const harness = rest.find((a) => a.startsWith("--harness="))?.split("=")[1] || "unknown";
  const maxTokens = Number(rest.find((a) => a.startsWith("--tokens="))?.split("=")[1] ?? 700);
  const quiet = rest.includes("--quiet");
  // Escape hatch for anyone who does not want a git subprocess on the
  // session-start path, and the control arm of bench/session.ts.
  const worktree = !rest.includes("--no-worktree");

  let d: memora | null = null;
  try {
    const payload = rest.includes("--no-stdin") ? "" : await readStdin();
    const event = parseHarnessEvent(payload, phase, harness);
    // The harness knows the working directory better than we do; a hook
    // may well run from somewhere else entirely.
    if (event.cwd) process.chdir(event.cwd);

    d = new memora({ path: dbPath(), skipGc: phase === "start" ? false : true });

    if (phase === "start") {
      const result = orient(d, event, { maxTokens, worktree });
      if (result.context) process.stdout.write(`${result.context}\n`);
      return;
    }

    const result = phase === "checkpoint" ? checkpoint(d, event) : finish(d, event);
    if (!quiet) {
      console.log(JSON.stringify({ systemMessage: describePreserve(result, phase) }));
    }
  } catch (err) {
    // Never fail a session over memory bookkeeping.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`memora session ${phase}: skipped (${message})`);
  } finally {
    d?.close();
  }
}

/** Read a hook payload from stdin, tolerating a closed or empty pipe. */
async function readStdin(): Promise<string> {
  try {
    if (process.stdin.isTTY) return "";
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}

function cmdLs(args: string[]): void {
  const useSession = args.includes("--session");
  const d = new memora({ path: dbPath(), skipGc: true });
  const slips = useSession ? d.listSession() : d.listKept(50);
  if (slips.length === 0) {
    console.log(useSession ? "(no slips in this session)" : "(no kept slips)");
  } else {
    for (const s of slips) {
      console.log(fmtSlip(s));
      console.log();
    }
  }
  d.close();
}

function cmdShow(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("usage: memora show <id>");
    process.exit(1);
  }
  const d = new memora({ path: dbPath(), skipGc: true });
  const s = d.get(id);
  if (!s) {
    console.error(`(no slip ${id})`);
    process.exit(1);
  }
  console.log(fmtSlip(s));
  console.log(`  used: ${s.usedCount}, wrong: ${s.wrongCount}`);
  const anchors = d.anchorStates(s.id);
  if (anchors.length > 0) {
    console.log(`  anchors:`);
    for (const state of anchors) {
      const where = state.anchor.symbol
        ? `${state.anchor.path}#${state.anchor.symbol}`
        : state.anchor.line
          ? `${state.anchor.path}:${state.anchor.line}`
          : state.anchor.path;
      const commit = state.anchor.commit ? ` @ ${state.anchor.commit.slice(0, 8)}` : "";
      console.log(`    ${state.status.padEnd(9)} ${where}${commit}`);
      console.log(`      ${state.detail}`);
    }
  }
  const links = d.storage.linksFrom(s.id);
  if (links.length > 0) {
    console.log(`  links:`);
    for (const l of links) console.log(`    ${l.kind} -> ${l.toId}`);
  }
  d.close();
}

function cmdStats(): void {
  const d = new memora({ path: dbPath(), skipGc: true });
  const c = d.counts();
  const claimed = readSessionPointer(d.scope, { dbPath: d.storage.path });
  console.log(`db:       ${d.storage.path}`);
  console.log(`scope:    ${d.scope} (${d.context.source})`);
  console.log(`root:     ${d.context.root}`);
  console.log(`session:  ${d.sessionId}${claimed ? ` (claimed by ${claimed.harness})` : " (per-process)"}`);
  console.log(`slips:    ${c.slips}`);
  console.log(`  kept:   ${c.kept}`);
  console.log(`  drafts: ${c.drafts}`);
  console.log(`  expired:${c.slips - c.kept - c.drafts}`);
  console.log(`handoffs: ${c.handoffs}`);
  console.log(`messages: ${c.messages}`);
  console.log(`  pending:${c.pending}`);
  d.close();
}

function fmtMsg(m: ReturnType<memora["inbox"]>[number]): string {
  const date = new Date(m.createdAt).toISOString().slice(0, 19);
  const delivery = m.delivery
    ? m.delivery.ok
      ? `\n  delivered via ${m.delivery.transport}: ${m.delivery.path}`
      : `\n  mailbox-only: ${m.delivery.reason}`
    : "";
  return `${m.id}  ${m.state}  ${date}  ${m.from} -> ${m.to}  thread ${m.threadId}\n  ${m.body.replace(/\n/g, "\n  ")}${delivery}`;
}

function cmdSend(args: string[]): void {
  const to = args[0];
  const body = args.slice(1).join(" ").trim();
  if (!to || !body) {
    console.error("usage: memora send <to> <message>");
    process.exit(1);
  }
  const d = new memora({ path: dbPath(), skipGc: true });
  const m = d.send({ to, body });
  console.log(fmtMsg(m));
  d.close();
}

function cmdInbox(args: string[]): void {
  const to = args.find((a) => a !== "--all") ?? author();
  const d = new memora({ path: dbPath(), skipGc: true });
  const msgs = d.inbox(to, { includeRead: args.includes("--all") });
  if (msgs.length === 0) console.log(`(no unread messages for ${to})`);
  for (const m of msgs) console.log(fmtMsg(m) + "\n");
  d.close();
}

function cmdRead(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("usage: memora read <id>");
    process.exit(1);
  }
  const d = new memora({ path: dbPath(), skipGc: true });
  console.log(d.read(id) ? `read ${id}` : `message ${id} not found`);
  d.close();
}

function cmdReply(args: string[]): void {
  const id = args[0];
  const body = args.slice(1).join(" ").trim();
  if (!id || !body) {
    console.error("usage: memora reply <id> <message>");
    process.exit(1);
  }
  const d = new memora({ path: dbPath(), skipGc: true });
  const m = d.reply(id, body);
  console.log(fmtMsg(m));
  d.close();
}

async function sharedClient(): Promise<Sharedmemora> {
  const gateway = process.env.memora_SHARED_GATEWAY;
  if (!gateway) throw new Error("memora_SHARED_GATEWAY is required for memora shared commands");
  return Sharedmemora.connect({ gateway, token: process.env.memora_SHARED_TOKEN });
}

async function cmdShared(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "mcp") {
    await import("./shared-mcp.ts");
    return;
  }
  const d = await sharedClient();
  try {
    switch (sub) {
      case "status": {
        const status = await d.refreshStatus();
        console.log(`shared: ${status.status}`);
        console.log(`local copy: ${status.mirrorRevision}`);
        console.log(`server: ${status.knownHeadRevision}`);
        console.log(`behind: ${status.freshness.behind}`);
        console.log(`current: ${status.freshness.fresh ? "yes" : "no"}`);
        return;
      }
      case "recall": {
        const query = args.join(" ").trim();
        if (!query) throw new Error("usage: memora shared recall <query>");
        const result = d.recall(query, 10);
        if (result.latestHandoff) {
          console.log(`-- latest handoff [change ${result.latestHandoff.revision}] --`);
          console.log(`  ${result.latestHandoff.summary}`);
          for (const next of result.latestHandoff.next) console.log(`  next: ${next}`);
          console.log();
        }
        if (result.hits.length === 0) console.log(`(no shared hits for "${query}"; local copy at change ${result.mirrorRevision})`);
        for (const hit of result.hits) console.log(`${hit.slipId}  change ${hit.revision}\n  ${hit.text}\n`);
        return;
      }
      case "remember": {
        const text = args.join(" ").trim();
        if (!text) throw new Error("usage: memora shared remember <text>");
        const saved = await d.remember(text);
        console.log(`saved shared memory ${saved.id} (change ${saved.receipt.revision}; immediately searchable here)`);
        return;
      }
      case "handoff": {
        const summary = args.join(" ").trim();
        if (!summary) throw new Error("usage: memora shared handoff <summary>");
        const saved = await d.handoff(summary);
        console.log(`saved shared handoff ${saved.id} (change ${saved.receipt.revision})`);
        return;
      }
      case "signal": {
        const id = args[0]; const action = args[1] as "used" | "wrong" | "forget" | undefined;
        if (!id || !action || !["used", "wrong", "forget"].includes(action)) throw new Error("usage: memora shared signal <id> <used|wrong|forget>");
        const saved = await d.signal(id, action);
        console.log(`saved shared signal ${id} ${action} (change ${saved.receipt.revision})`);
        return;
      }
      case "delete": {
        const id = args[0];
        if (!id) throw new Error("usage: memora shared delete <id>");
        const saved = await d.delete(id);
        console.log(`deleted shared memory ${id} (change ${saved.receipt.revision}; removed from synced local copies and redacted from server replay)`);
        return;
      }
      default:
        throw new Error("usage: memora shared <status|recall|remember|handoff|signal|delete|mcp> ...");
    }
  } finally {
    await d.close();
  }
}

function cmdHandoffs(): void {
  const d = new memora({ path: dbPath(), skipGc: true });
  const hs = d.latestHandoffs(10);
  if (hs.length === 0) {
    console.log("(no handoffs)");
  } else {
    for (const h of hs) {
      const date = new Date(h.createdAt).toISOString().slice(0, 19);
      console.log(`${h.id}  ${date}  ${h.authoredBy}  (session ${h.sessionId})`);
      console.log(`  ${h.summary.replace(/\n/g, "\n  ")}`);
      if (h.kept.length > 0) console.log(`  kept: ${h.kept.length} slip(s)`);
      if (h.next.length > 0) {
        console.log(`  next:`);
        for (const n of h.next) console.log(`    - ${n}`);
      }
      console.log();
    }
  }
  d.close();
}

let [, , cmd, ...rest] = process.argv;
if (cmd === "as") {
  const who = rest.shift();
  if (!who || rest.length === 0) {
    console.error("usage: memora as <author> <command...>");
    process.exit(1);
  }
  process.env.memora_AUTHOR = who;
  cmd = rest.shift();
}
switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "mcp":
    // Boot the MCP stdio server in this process. Importing for side
    // effects: mcp.ts attaches to stdin/stdout and connects the
    // transport at module load. Agent clients launch us with
    // `memora mcp` and start sending JSON-RPC.
    await import("./mcp.ts");
    break;
  case "verify":
    cmdVerify();
    break;
  case "doctor":
    cmdDoctor(rest);
    break;
  case "recall":
    cmdRecall(rest);
    break;
  case "remember":
    cmdRemember(rest);
    break;
  case "orient":
    cmdOrient(rest);
    break;
  case "touching":
    cmdTouching(rest);
    break;
  case "anchors":
    cmdAnchors(rest);
    break;
  case "handoff":
    cmdWriteHandoff(rest);
    break;
  case "resolve":
    cmdResolve(rest);
    break;
  case "link":
    cmdLink(rest);
    break;
  case "assess":
    cmdAssess(rest);
    break;
  case "eval":
    cmdEval(rest);
    break;
  case "forget-session":
    cmdForgetSession(rest);
    break;
  case "install":
    cmdInstall(rest);
    break;
  case "session":
    await cmdSession(rest);
    break;
  case "ls":
    cmdLs(rest);
    break;
  case "show":
    cmdShow(rest);
    break;
  case "stats":
    cmdStats();
    break;
  case "handoffs":
    cmdHandoffs();
    break;
  case "send":
    cmdSend(rest);
    break;
  case "inbox":
    cmdInbox(rest);
    break;
  case "read":
    cmdRead(rest);
    break;
  case "reply":
    cmdReply(rest);
    break;
  case "shared":
    await cmdShared(rest);
    break;
  default:
    usage();
}
