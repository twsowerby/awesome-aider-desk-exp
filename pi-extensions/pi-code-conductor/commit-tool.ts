import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerCommitTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "commit",
    label: "Git Commit",
    description: "Create an atomic git commit of all changes.",
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "Commit message. If omitted, one will be generated from the diff." }))
    }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      try {
        // 1. Add all changes
        await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });

        let message = args.message;
        if (!message) {
          // 2. Generate message from diff if not provided
          const diffStat = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd });
          if (!diffStat.stdout.trim()) {
            return "No changes to commit.";
          }
          message = `Update:\n${diffStat.stdout.trim()}`;
        }

        // 3. Commit
        // Sanitize message for shell (though pi.exec handles args as array, which is safer)
        const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd: ctx.cwd });
        
        // 4. Get commit hash
        const revResult = await pi.exec("git", ["rev-parse", "HEAD"], { cwd: ctx.cwd });
        const hash = revResult.stdout.trim().slice(0, 7);

        return `Committed [${hash}]: ${message.split("\n")[0]}`;
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Commit failed: ${err.message}` }] };
      }
    }
  });
}
