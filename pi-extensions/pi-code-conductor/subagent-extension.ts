import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerResultTools } from "./result-capture.js";
import { createSecurityGate } from "./security-gate.js";

export default function(pi: ExtensionAPI) {
  // Register only the tools needed for subagents
  registerResultTools(pi);
  
  // Apply the same security gate to subagents
  createSecurityGate(pi);
}
