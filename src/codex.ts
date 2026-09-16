import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

const TIMEOUT_MS = 120_000;
const IMPORT_COMPLETED = "externalAgentConfig/import/completed";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  label: string;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Codex ${label}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid Codex ${label}: expected a non-empty string.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A direct, bounded JSONL connection. Call initialize(), and always await close(). */
export class CodexClient {
  #process: ChildProcessWithoutNullStreams;
  #lines: Interface;
  #pending = new Map<number, Pending>();
  #imports = new Map<string, unknown>();
  #importWaiters = new Map<string, Pending>();
  #nextId = 1;
  #stderr = "";
  #failure: Error | undefined;
  #closed = false;
  #exited = false;
  #exit: Promise<void>;
  #closing: Promise<void> | undefined;

  constructor(cwd: string) {
    this.#process = spawn("codex", ["app-server"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process.stdout.setEncoding("utf8");
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-16_384);
    });
    this.#process.on("error", (error: Error) => {
      this.#fail(this.#error(`Cannot run codex app-server: ${error.message}`));
    });
    this.#process.stdin.on("error", (error: Error) => {
      this.#fail(this.#error(`Cannot write to codex app-server: ${error.message}`));
    });
    this.#process.stdout.on("error", (error: Error) => {
      this.#fail(this.#error(`Cannot read codex app-server output: ${error.message}`));
    });
    this.#process.stderr.on("error", (error: Error) => {
      this.#fail(this.#error(`Cannot read codex app-server diagnostics: ${error.message}`));
    });
    const exit = Promise.withResolvers<void>();
    this.#exit = exit.promise;
    this.#process.once("close", (code, signal) => {
      this.#exited = true;
      this.#fail(this.#error(`codex app-server closed (${signal ?? `exit ${code}`}).`));
      exit.resolve();
    });
    this.#lines = createInterface({ input: this.#process.stdout });
    this.#lines.on("line", (line) => this.#receive(line));
  }

  async initialize(): Promise<void> {
    object(
      await this.request("initialize", {
        clientInfo: { name: "omp_codex_transfer", title: "OMP Codex Transfer", version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }),
      "initialize response",
    );
    this.#send({ method: "initialized", params: {} });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#failure || this.#closed) {
      return Promise.reject(this.#failure ?? this.#error("Codex client is closed."));
    }
    const id = this.#nextId++;
    const pending = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#fail(this.#error(`Timed out after ${TIMEOUT_MS / 1000}s waiting for Codex ${method}.`));
    }, TIMEOUT_MS);
    this.#pending.set(id, { resolve: pending.resolve, reject: pending.reject, timer, label: method });
    this.#send({ id, method, params });
    return pending.promise;
  }

  /** Completion notifications are captured from process startup, including before the RPC response. */
  waitForImport(importId: string): Promise<unknown> {
    if (this.#failure || this.#closed) {
      return Promise.reject(this.#failure ?? this.#error("Codex client is closed."));
    }
    if (this.#imports.has(importId)) {
      const result = this.#imports.get(importId);
      this.#imports.delete(importId);
      return Promise.resolve(result);
    }
    if (this.#importWaiters.has(importId)) {
      return Promise.reject(new Error(`Already waiting for Codex import ${importId}.`));
    }
    const pending = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#fail(
        this.#error(
          `Timed out after ${TIMEOUT_MS / 1000}s waiting for Codex import ${importId} to complete.`,
        ),
      );
    }, TIMEOUT_MS);
    this.#importWaiters.set(importId, {
      resolve: pending.resolve,
      reject: pending.reject,
      timer,
      label: importId,
    });
    return pending.promise;
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#fail(this.#error("Codex client closed."));
    this.#imports.clear();
    this.#lines.close();
    if (this.#exited) return;
    this.#process.stdin.end();
    const terminate = setTimeout(() => this.#process.kill("SIGTERM"), 200);
    const kill = setTimeout(() => this.#process.kill("SIGKILL"), 1_200);
    const timeout = Promise.withResolvers<never>();
    const deadline = setTimeout(
      () => timeout.reject(this.#error("codex app-server did not close after SIGKILL.")),
      5_000,
    );
    try {
      await Promise.race([this.#exit, timeout.promise]);
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
      clearTimeout(deadline);
      this.#process.stdin.destroy();
      this.#process.stdout.destroy();
      this.#process.stderr.destroy();
    }
  }

  #error(message: string): Error {
    const stderr = this.#stderr.trim();
    return new Error(stderr ? `${message}\nCodex stderr:\n${stderr}` : message);
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of [...this.#pending.values(), ...this.#importWaiters.values()]) {
      clearTimeout(pending.timer);
      pending.reject(this.#failure);
    }
    this.#pending.clear();
    this.#importWaiters.clear();
  }

  #send(message: unknown): void {
    try {
      this.#process.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.#fail(this.#error(`Cannot send Codex request: ${errorMessage(error)}`));
    }
  }

  #receive(line: string): void {
    if (!line.trim() || this.#closed || this.#failure) return;
    try {
      const message = object(JSON.parse(line), "JSONL message");
      if ("method" in message) {
        const method = text(message.method, "notification method");
        if ("id" in message) {
          if (typeof message.id !== "number" && typeof message.id !== "string") {
            throw new Error("Invalid Codex server request id.");
          }
          this.#send({
            id: message.id,
            error: { code: -32601, message: `Unsupported server request: ${method}` },
          });
        } else if (method === IMPORT_COMPLETED) {
          const params = object(message.params, "import completion");
          const importId = text(params.importId, "import completion id");
          const waiter = this.#importWaiters.get(importId);
          if (waiter) {
            this.#importWaiters.delete(importId);
            clearTimeout(waiter.timer);
            waiter.resolve(params);
          } else {
            this.#imports.set(importId, params);
          }
        }
        return;
      }
      if (typeof message.id !== "number") throw new Error("Invalid Codex response id.");
      const pending = this.#pending.get(message.id);
      if (!pending) throw new Error(`Unexpected Codex response id ${message.id}.`);
      let rpcError: Error | undefined;
      if ("error" in message) {
        const error = object(message.error, "RPC error");
        const detail = text(error.message, "RPC error message");
        if (typeof error.code !== "number") throw new Error("Invalid Codex RPC error code.");
        rpcError = this.#error(
          `Codex ${pending.label} failed (${error.code}): ${detail}${error.data === undefined ? "" : `\n${JSON.stringify(error.data)}`}`,
        );
      } else if (!("result" in message)) {
        throw new Error("Invalid Codex response: missing result.");
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (rpcError) pending.reject(rpcError);
      else pending.resolve(message.result);
    } catch (error) {
      this.#fail(this.#error(`Invalid codex app-server protocol: ${errorMessage(error)}`));
    }
  }
}

function checkImportCompletion(value: unknown): void {
  const completion = object(value, "import completion");
  if (!Array.isArray(completion.itemTypeResults)) {
    throw new Error("Invalid Codex import completion: missing itemTypeResults.");
  }
  let sessionsReported = false;
  const failures: string[] = [];
  for (const value of completion.itemTypeResults) {
    const result = object(value, "import item result");
    const itemType = text(result.itemType, "import item type");
    sessionsReported ||= itemType === "SESSIONS";
    if (!Array.isArray(result.failures) || !Array.isArray(result.successes)) {
      throw new Error("Invalid Codex import result: missing successes or failures.");
    }
    for (const value of result.failures) {
      const failure = object(value, "import failure");
      failures.push(
        `${itemType}/${text(failure.failureStage, "failure stage")}: ${text(failure.message, "failure message")}`,
      );
    }
  }
  if (failures.length) throw new Error(`Codex session import failed:\n${failures.join("\n")}`);
  if (!sessionsReported) throw new Error("Codex import completed without a SESSIONS result.");
}

export async function importSnapshot(sourcePath: string, cwd: string, title: string): Promise<string> {
  const canonicalSource = await realpath(sourcePath);
  const contentSha256 = createHash("sha256")
    .update(await readFile(canonicalSource))
    .digest("hex");
  const ledgerPath = join(
    resolve(process.env.CODEX_HOME || join(homedir(), ".codex")),
    "external_agent_session_imports.json",
  );
  const client = new CodexClient(cwd);
  try {
    await client.initialize();
    const response = object(
      await client.request("externalAgentConfig/import", {
        migrationItems: [
          {
            itemType: "SESSIONS",
            description: `Transfer OMP snapshot ${basename(canonicalSource)}`,
            cwd: null,
            details: {
              plugins: [],
              sessions: [{ path: canonicalSource, cwd, title }],
              mcpServers: [],
              hooks: [],
              subagents: [],
              commands: [],
            },
          },
        ],
      }),
      "import response",
    );
    checkImportCompletion(await client.waitForImport(text(response.importId, "import id")));

    let ledger: Record<string, unknown>;
    try {
      ledger = object(JSON.parse(await readFile(ledgerPath, "utf8")), "import ledger");
    } catch (error) {
      throw new Error(`Cannot read Codex import ledger ${ledgerPath}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (!Array.isArray(ledger.records))
      throw new Error(`Invalid Codex import ledger ${ledgerPath}: missing records.`);
    let threadId: string | undefined;
    for (const value of ledger.records) {
      const record = object(value, "import ledger record");
      if (record.source_path === canonicalSource && record.content_sha256 === contentSha256) {
        threadId = text(record.imported_thread_id, "imported thread id");
      }
    }
    if (!threadId)
      throw new Error(
        `Codex reported completion but ${ledgerPath} has no matching source path and SHA256 for ${canonicalSource}.`,
      );
    const read = object(
      await client.request("thread/read", { threadId, includeTurns: true }),
      "thread/read response",
    );
    const thread = object(read.thread, "thread/read thread");
    if (thread.id !== threadId || !Array.isArray(thread.turns)) {
      throw new Error(`Codex thread/read did not return imported thread ${threadId} with its turns.`);
    }
    if (thread.name !== title) await client.request("thread/name/set", { threadId, name: title });
    return threadId;
  } finally {
    await client.close();
  }
}
