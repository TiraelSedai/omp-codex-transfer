import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntry as Entry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

type Session = Pick<
  ReadonlySessionManager,
  "getBranch" | "getSessionName" | "getSessionId" | "getSessionFile" | "getArtifactsDir"
>;

function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freezeDeep(child);
  Object.freeze(value);
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function visibleMessages(response: unknown): { user: string; assistant: string } {
  const thread = object(object(response).thread);
  assert.ok(Array.isArray(thread.turns));
  const user: string[] = [];
  const assistant: string[] = [];
  for (const turn of thread.turns) {
    const items = object(turn).items;
    assert.ok(Array.isArray(items));
    for (const raw of items) {
      const item = object(raw);
      if (item.type === "agentMessage") {
        assert.equal(typeof item.text, "string");
        assistant.push(String(item.text));
      } else if (item.type === "userMessage") {
        assert.ok(Array.isArray(item.content));
        for (const rawContent of item.content) {
          const content = object(rawContent);
          if (content.type === "text") {
            assert.equal(typeof content.text, "string");
            user.push(String(content.text));
          }
        }
      }
    }
  }
  return { user: user.join("\n"), assistant: assistant.join("\n") };
}

test(
  "real Codex imports only the active branch, keeps recoverable history, and creates independent snapshots",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-codex-transfer-test-"));
    const home = join(root, "home");
    const cwd = join(root, "workspace");
    const codexHome = join(home, ".codex");
    const environment: Record<string, string | undefined> = {
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
    };
    const originalEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
    try {
      await mkdir(cwd, { recursive: true });
      await mkdir(codexHome, { recursive: true });
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      assert.equal(homedir(), home, "The test must never use the real home directory");
      const binary = spawnSync("codex", ["--version"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(
        binary.status,
        0,
        `A real installed codex is required: ${binary.error?.message ?? binary.stderr}`,
      );
      // Import only after isolation, including any module-level path resolution.
      const { exportSnapshot } = await import("../src/snapshot.ts");
      const { importSnapshot, CodexClient } = await import("../src/codex.ts");
      const timestamp = "2026-09-16T10:00:00.000Z";
      const time = Date.parse(timestamp);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
        "base64",
      );
      const toolOutput = `TOOL_RESULT_VISIBLE\n${"long-tool-output ".repeat(2_000)}\nORIGINAL_TOOL_TAIL`;
      const entries: Entry[] = [
        {
          type: "message",
          id: "user-root",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [
              { type: "text", text: "USER_VISIBLE: inspect the transfer screenshot" },
              { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            ],
            timestamp: time,
          },
        },
        {
          type: "message",
          id: "assistant-tool",
          parentId: "user-root",
          timestamp,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "HIDDEN_REASONING_NEVER_EXPORT" },
              { type: "redactedThinking", data: "HIDDEN_REDACTED_NEVER_EXPORT" },
              { type: "text", text: "ASSISTANT_VISIBLE: examining the local file" },
              {
                type: "toolCall",
                id: "read-call",
                name: "read",
                arguments: { path: "TOOL_ARGUMENT_VISIBLE.txt" },
              },
            ],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture-no-model-request",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: time,
          },
        },
        {
          type: "message",
          id: "tool-result",
          parentId: "assistant-tool",
          timestamp,
          message: {
            role: "toolResult",
            toolCallId: "read-call",
            toolName: "read",
            content: [{ type: "text", text: toolOutput }],
            isError: false,
            timestamp: time,
          },
        },
        {
          type: "compaction",
          id: "compaction",
          parentId: "tool-result",
          timestamp,
          summary: "COMPACTION_VISIBLE: preserve the migration constraint",
          firstKeptEntryId: "tool-result",
          tokensBefore: 20_000,
        },
        {
          type: "branch_summary",
          id: "branch-summary",
          parentId: "compaction",
          timestamp,
          fromId: "sibling",
          summary: "BRANCH_SUMMARY_VISIBLE: selected the local approach",
        },
        {
          type: "message",
          id: "active-leaf",
          parentId: "branch-summary",
          timestamp,
          message: {
            role: "user",
            content: "ACTIVE_LEAF_VISIBLE: continue from this branch",
            timestamp: time,
          },
        },
      ];
      const sibling: Entry = {
        type: "message",
        id: "sibling",
        parentId: "user-root",
        timestamp,
        message: { role: "user", content: "FORK_SIBLING_NEVER_EXPORT", timestamp: time },
      };
      const allEntries = [...entries, sibling];
      const before = structuredClone(allEntries);
      freezeDeep(allEntries);
      const originalSession = join(root, "original-omp-session.jsonl");
      const originalBytes = allEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      await writeFile(originalSession, originalBytes);
      const artifacts = join(root, "original-artifacts");
      await mkdir(artifacts);
      const session = {
        getBranch: () => entries,
        getEntries: () => allEntries,
        getSessionName: () => "Transfer regression fixture",
        getSessionId: () => "original-session-id",
        getSessionFile: () => originalSession,
        getArtifactsDir: () => artifacts,
      } satisfies Session & { getEntries: () => Entry[] };
      const ids: string[] = [];
      const paths: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const snapshot = await exportSnapshot(session, cwd);
        const sourceRelative = relative(join(home, ".claude", "projects"), snapshot.sourcePath);
        assert.ok(!sourceRelative.startsWith(`..${sep}`) && sourceRelative !== "..");
        assert.equal(snapshot.imageCount, 1);
        const source = await readFile(snapshot.sourcePath, "utf8");
        assert.ok(source.includes("ORIGINAL_TOOL_TAIL"), "The full original tool result stays available");
        assert.ok(source.includes(originalSession), "Provenance retains the original OMP session path");
        assert.doesNotMatch(
          source,
          /FORK_SIBLING_NEVER_EXPORT|HIDDEN_REASONING_NEVER_EXPORT|HIDDEN_REDACTED_NEVER_EXPORT/,
        );
        const sourceRecords: unknown[] = source
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const sourceText = sourceRecords.map((record) => JSON.stringify(record)).join("\n");
        assert.ok(sourceText.includes(JSON.stringify(toolOutput).slice(1, -1)));
        assert.equal((await stat(snapshot.sourcePath)).mode & 0o077, 0, "Private transcript permissions");
        assert.equal((await stat(dirname(snapshot.sourcePath))).mode & 0o077, 0, "Private export directory");
        const id = await importSnapshot(snapshot.sourcePath, cwd, snapshot.title);
        const client = new CodexClient(cwd);
        try {
          await client.initialize();
          const response = await client.request("thread/read", { threadId: id, includeTurns: true });
          const visible = visibleMessages(response);
          assert.ok(visible.user.includes("USER_VISIBLE: inspect the transfer screenshot"));
          assert.ok(visible.assistant.includes("ASSISTANT_VISIBLE: examining the local file"));
          const text = `${visible.user}\n${visible.assistant}`;
          for (const marker of [
            "TOOL_ARGUMENT_VISIBLE.txt",
            "TOOL_RESULT_VISIBLE",
            "COMPACTION_VISIBLE: preserve the migration constraint",
            "BRANCH_SUMMARY_VISIBLE: selected the local approach",
            "ACTIVE_LEAF_VISIBLE: continue from this branch",
            snapshot.sourcePath,
          ]) {
            assert.ok(text.includes(marker), `Imported history must expose ${marker}`);
          }
          assert.doesNotMatch(
            JSON.stringify(response),
            /FORK_SIBLING_NEVER_EXPORT|HIDDEN_REASONING_NEVER_EXPORT|HIDDEN_REDACTED_NEVER_EXPORT/,
          );
          const imagePath = /OMP image: ([^\r\n]+)/.exec(text)?.[1];
          assert.ok(imagePath, "The imported transcript must point to a recoverable image");
          assert.deepEqual(await readFile(imagePath), png);
        } finally {
          await client.close();
        }
        ids.push(id);
        paths.push(snapshot.sourcePath);
      }
      assert.notEqual(ids[0], ids[1], "Repeating the transfer creates independent Codex threads");
      assert.notEqual(paths[0], paths[1], "Repeating the transfer never overwrites the prior snapshot");
      assert.deepEqual(allEntries, before, "Export must not mutate any original entry");
      assert.equal(await readFile(originalSession, "utf8"), originalBytes);
    } finally {
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
