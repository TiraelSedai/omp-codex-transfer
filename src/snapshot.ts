import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";

type SnapshotSession = Pick<
  ReadonlySessionManager,
  "getBranch" | "getSessionName" | "getSessionId" | "getSessionFile" | "getArtifactsDir"
>;
type Block = AssistantMessage["content"][number];
type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; is_error: boolean; content: ClaudeBlock[] };

/** Export the branch, not the JSONL file: sibling branches must never become conversation history. */
export async function exportSnapshot(session: SnapshotSession, cwd: string) {
  const branch = session.getBranch();
  if (
    !branch.some(
      (entry) =>
        entry.type === "message" ||
        entry.type === "compaction" ||
        entry.type === "branch_summary" ||
        entry.type === "custom_message",
    )
  ) {
    throw new Error("The active OMP branch has no conversation to transfer.");
  }
  const sessionId = session.getSessionId();
  const sessionFile = session.getSessionFile();
  const artifactsDir = session.getArtifactsDir();
  const title = `[OMP] ${session.getSessionName() || sessionId}`;
  // Codex's Claude importer only accepts sources inside ~/.claude/projects.
  const projects = join(homedir(), ".claude", "projects");
  await mkdir(projects, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(projects, "omp-transfer-"));
  const sourcePath = join(directory, "session.jsonl");
  let imageCount = 0;
  const file = await open(sourcePath, "wx", 0o600);
  let parentUuid: string | null = null;
  let sequence = 0;
  const text = (value: string): ClaudeBlock => ({ type: "text", text: value });

  async function content(blocks: string | readonly Block[]): Promise<ClaudeBlock[]> {
    if (typeof blocks === "string") return blocks.trim() ? [text(blocks)] : [];
    const result: ClaudeBlock[] = [];
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          if (block.text.trim()) result.push(text(block.text));
          break;
        case "image": {
          const extensions: Record<string, string> = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/webp": "webp",
            "image/gif": "gif",
          };
          const extension = extensions[block.mimeType];
          if (!extension) throw new Error(`Unsupported OMP image MIME type: ${block.mimeType}`);
          const imagePath = join(directory, `image-${++imageCount}.${extension}`);
          await writeFile(imagePath, Buffer.from(block.data, "base64"), { flag: "wx", mode: 0o600 });
          result.push(
            text(
              `OMP image: ${imagePath}\nUse the image viewer to inspect this original attachment (${block.mimeType}).`,
            ),
          );
          break;
        }
        case "toolCall":
          result.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
          break;
        case "anthropicServerTool":
          result.push(text(`[OMP provider tool history]\n${JSON.stringify(block.block)}`));
          break;
        case "thinking":
        case "redactedThinking":
        case "fallback":
          break;
      }
    }
    return result;
  }

  async function message(role: "user" | "assistant", blocks: ClaudeBlock[], timestamp: string) {
    if (blocks.length === 0) return;
    const uuid = `${sessionId}-${++sequence}`;
    await file.write(
      `${JSON.stringify({ type: role, uuid, parentUuid, sessionId, cwd, timestamp, message: { role, content: blocks } })}\n`,
    );
    parentUuid = uuid;
  }

  try {
    await file.write(`${JSON.stringify({ type: "custom-title", customTitle: title, sessionId, cwd })}\n`);
    for (const entry of branch) {
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        await message(
          "user",
          [text(`[OMP ${entry.type === "compaction" ? "compaction" : "branch"} summary]\n${entry.summary}`)],
          entry.timestamp,
        );
      } else if (entry.type === "reset_boundary") {
        await message(
          "user",
          [
            text(
              "[OMP context reset]\nThe user cleared the working context here. Earlier messages are archival history, not the current task.",
            ),
          ],
          entry.timestamp,
        );
      } else if (entry.type === "custom_message") {
        if (entry.customType === "interrupted-thinking") continue;
        await message("user", await content(entry.content), entry.timestamp);
      } else if (entry.type === "message") {
        const m = entry.message;
        switch (m.role) {
          case "user":
          case "assistant":
            await message(m.role, await content(m.content), entry.timestamp);
            break;
          case "toolResult":
            await message(
              "user",
              [
                {
                  type: "tool_result",
                  tool_use_id: m.toolCallId,
                  is_error: m.isError,
                  content: await content(m.content),
                },
              ],
              entry.timestamp,
            );
            break;
          case "compactionSummary":
          case "branchSummary":
            await message(
              "user",
              [
                text(
                  `[OMP ${m.role === "compactionSummary" ? "compaction" : "branch"} summary]\n${m.summary}`,
                ),
                ...(m.role === "compactionSummary" ? await content(m.blocks ?? m.images ?? []) : []),
              ],
              entry.timestamp,
            );
            break;
          case "custom":
          case "hookMessage":
            if (m.customType !== "interrupted-thinking")
              await message("user", await content(m.content), entry.timestamp);
            break;
          case "bashExecution":
          case "pythonExecution":
            if (!m.excludeFromContext)
              await message(
                "user",
                [
                  text(
                    `[OMP ${m.role}]\n${m.role === "bashExecution" ? m.command : m.code}\nExit code: ${m.exitCode}; cancelled: ${m.cancelled}\n${m.output}`,
                  ),
                  ...(m.role === "bashExecution" ? await content(m.images ?? []) : []),
                ],
                entry.timestamp,
              );
            break;
          case "fileMention":
            for (const mentioned of m.files) {
              await message(
                "user",
                [
                  text(`[OMP file: ${mentioned.path}]\n${mentioned.content}`),
                  ...(mentioned.image ? await content([mentioned.image]) : []),
                ],
                entry.timestamp,
              );
            }
            break;
          default:
            throw new Error(`Unsupported OMP message role: ${m.role}`);
        }
      }
    }
    if (sequence === 0) throw new Error("The active OMP branch has no visible conversation to transfer.");
    await message(
      "user",
      [
        text(
          [
            "[OMP transfer context]",
            "This is an independent snapshot of the active OMP branch. The OMP session is unchanged; subsequent work is not synchronized.",
            `Working directory: ${cwd}`,
            `Complete exported transcript: ${sourcePath}`,
            sessionFile ? `Original OMP session: ${sessionFile}` : "Original OMP session was in memory.",
            artifactsDir ? `OMP artifact:// references refer to files in: ${artifactsDir}` : "",
            "Codex imports tool activity as historical text, not executable calls, and may shorten long tool arguments/results. Read the exported transcript for the complete visible content.",
            "Images are saved alongside that transcript and referenced by absolute path. Internal reasoning and provider replay state were not transferred.",
            "Subagent activity is history only; OMP agent:// and local:// handles are not live Codex agents or resources.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ],
      new Date().toISOString(),
    );
  } catch (error) {
    await file.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  await file.close();
  return { sourcePath, title, imageCount };
}
