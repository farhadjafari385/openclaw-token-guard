import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { createState, decide, endRun } from "./guard.js";
import { inboxArgs, runInbox } from "./inbox.js";

// No top-level await: OpenClaw loads plugin entries through require(), which
// rejects ESM graphs that use it.

const state = createState();

export default definePluginEntry({
  id: "token-guard",
  name: "Token Guard",
  description: "Blocks token-burning polling, sleep loops and runaway runs; adds a task inbox for batching work.",
  register(api) {
    const log = (level, message, meta) => {
      try {
        const fn = api.logger && typeof api.logger[level] === "function" ? api.logger[level] : null;
        if (fn) fn.call(api.logger, meta ? `${message} ${JSON.stringify(meta)}` : message);
      } catch {
        // logging must never break a tool call
      }
    };

    api.on(
      "before_tool_call",
      (event, ctx) => {
        try {
          return decide(event, ctx, state, api.pluginConfig || {}, log);
        } catch (error) {
          // before_tool_call fails closed on a thrown error; fail open instead so a
          // guard bug can never block every tool call.
          log("error", "token-guard internal error; allowing the call", { error: String(error && error.message) });
          return undefined;
        }
      },
      { priority: 50 },
    );

    try {
      api.on("agent_end", (event, ctx) => {
        try {
          endRun(state, event, ctx);
        } catch {
          // best effort; TTL cleanup covers misses
        }
      });
    } catch (error) {
      log("warn", "token-guard: agent_end hook unavailable; using TTL cleanup", { error: String(error && error.message) });
    }

    const text = (description) => Type.Optional(Type.String({ description }));
    api.registerTool({
      name: "task_inbox",
      optional: true,
      description:
        "One inbox for all incoming tasks and bugs. add: record one item (project, title, type, priority, details, done_when, source). " +
        "list: show items. plan: group open items into one batch per project, highest priority first, and flag items that need info. " +
        "set: change an item's status (open|planned|dispatched|done|blocked|dropped). show: one item.",
      parameters: Type.Object({
        action: Type.String({ description: "add | list | plan | set | show" }),
        id: text("Item id for set/show."),
        project: text("Project name (add, list filter)."),
        title: text("One-line title (add)."),
        type: text("bug | task | feature | question (add)."),
        priority: text("low | normal | high | urgent (add)."),
        details: text("What is wrong or wanted; expected vs actual (add)."),
        done_when: text("Exact checks that prove it is done (add)."),
        source: text("Where it came from, e.g. a message id (add)."),
        status: text("New status (set) or status filter (list)."),
        batch: text("Batch label (set)."),
        note: text("Short note (set)."),
        json: Type.Optional(Type.Boolean({ description: "JSON output for list/plan." })),
      }),
      async execute(_id, params) {
        let args;
        try {
          args = inboxArgs(params);
        } catch (error) {
          return { content: [{ type: "text", text: `task_inbox: ${error.message}` }], details: { ok: false } };
        }
        const { code, text: output } = await runInbox(args);
        return {
          content: [{ type: "text", text: output || (code === 0 ? "ok" : `task_inbox failed (exit ${code})`) }],
          details: { ok: code === 0, exitCode: code },
        };
      },
    });
  },
});
