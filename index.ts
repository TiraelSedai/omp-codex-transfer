import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { exportSnapshot } from "./src/snapshot.ts";
import { importSnapshot } from "./src/codex.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export default function codexTransfer(pi: ExtensionAPI): void {
  let transferring = false;
  pi.registerCommand("codex-transfer", {
    description: "Copy the active branch into an independent Codex session",
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify("Использование: /codex-transfer (без аргументов)", "error");
        return;
      }
      if (transferring) {
        ctx.ui.notify("Перенос в Codex уже выполняется.", "warning");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Дождитесь завершения ответа OMP и очереди сообщений, затем повторите /codex-transfer.",
          "warning",
        );
        return;
      }
      transferring = true;
      let sourcePath: string | undefined;
      try {
        const cwd = ctx.cwd;
        const snapshot = await exportSnapshot(ctx.sessionManager, cwd);
        sourcePath = snapshot.sourcePath;
        ctx.ui.notify("Импортирую снимок активной ветки в Codex...", "info");
        const threadId = await importSnapshot(sourcePath, cwd, snapshot.title);
        ctx.ui.notify(
          [
            `Codex session: ${threadId}`,
            `cd ${shellQuote(cwd)} && codex resume ${shellQuote(threadId)}`,
            `Снимок: ${sourcePath}`,
            "OMP-сессия не изменена. Дальнейшие изменения не синхронизируются.",
            "История инструментов перенесена текстом; полные результаты доступны в снимке.",
            ...(snapshot.imageCount
              ? [`Изображения (${snapshot.imageCount}) сохранены рядом со снимком; пути переданы Codex.`]
              : []),
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          [
            `Перенос в Codex не завершён: ${error instanceof Error ? error.message : String(error)}`,
            ...(sourcePath ? [`Снимок сохранён: ${sourcePath}`] : []),
          ].join("\n"),
          "error",
        );
      } finally {
        transferring = false;
      }
    },
  });
}
