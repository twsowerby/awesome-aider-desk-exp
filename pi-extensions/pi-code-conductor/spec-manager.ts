import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerSpecTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "update-spec",
    label: "Update SPEC.md",
    description: "Update the SPEC.md file with latest requirements and status.",
    parameters: Type.Object({
      content: Type.String({ description: "Full markdown content for SPEC.md" })
    }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      const specPath = path.join(ctx.cwd, "SPEC.md");
      try {
        fs.writeFileSync(specPath, args.content, "utf-8");
        if (ctx.hasUI) {
          ctx.ui.notify("SPEC.md updated", "info");
        }
        return { content: [{ type: "text", text: "SPEC.md updated successfully" }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Failed to update SPEC.md: ${err.message}` }] };
      }
    }
  });

  pi.registerTool({
    name: "read-spec",
    label: "Read SPEC.md",
    description: "Read the current SPEC.md file.",
    parameters: Type.Object({}),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      const specPath = path.join(ctx.cwd, "SPEC.md");
      if (!fs.existsSync(specPath)) {
        return { content: [{ type: "text", text: "No SPEC.md found" }] };
      }
      try {
        const content = fs.readFileSync(specPath, "utf-8");
        return { content: [{ type: "text", text: content }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Failed to read SPEC.md: ${err.message}` }] };
      }
    }
  });
}
