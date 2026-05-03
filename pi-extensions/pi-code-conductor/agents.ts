import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
}

export interface CustomToolConfig {
  name: string;
  command: string;
  description: string;
}

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project" | "bundled";
  filePath: string;
  mcp_servers?: McpServerConfig[];
  custom_tools?: CustomToolConfig[];
  output_schema?: string;
  directives?: string[];
}

function parseFrontmatter(content: string): { frontmatter: any, body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  
  const yamlStr = match[1];
  const body = match[2];
  const frontmatter: any = {};
  
  const lines = yamlStr.split("\n");
  let currentKey: string | null = null;
  let currentList: any[] | null = null;

  for (const line of lines) {
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1];
      const value = keyMatch[2].trim();
      if (value.startsWith("[") && value.endsWith("]")) {
         frontmatter[key] = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      } else if (value === "" || value === ">") {
        currentKey = key;
        currentList = null;
      } else {
        frontmatter[key] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    const listMatch = line.match(/^\s*-\s*(.*)$/);
    if (listMatch && currentKey) {
      if (!frontmatter[currentKey]) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
  }
  
  return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "user" | "project" | "bundled"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter.name) continue;

    const tools = typeof frontmatter.tools === "string" 
      ? frontmatter.tools.split(",").map((t: string) => t.trim()).filter(Boolean)
      : Array.isArray(frontmatter.tools) ? frontmatter.tools : undefined;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description || "",
      tools,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
      mcp_servers: frontmatter.mcp_servers,
      custom_tools: frontmatter.custom_tools,
      output_schema: frontmatter.output_schema,
      directives: frontmatter.directives,
    });
  }
  return agents;
}

export function discoverAgents(cwd: string): AgentConfig[] {
  const bundledDir = path.join(__dirname, "agents");
  const globalDir = path.join(os.homedir(), ".pi", "agent", "agents");
  
  let projectDir: string | null = null;
  let curr = cwd;
  while (true) {
    const candidate = path.join(curr, ".pi", "agents");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      projectDir = candidate;
      break;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  const bundled = loadAgentsFromDir(bundledDir, "bundled");
  const global = loadAgentsFromDir(globalDir, "user");
  const project = projectDir ? loadAgentsFromDir(projectDir, "project") : [];

  const agentMap = new Map<string, AgentConfig>();
  for (const a of bundled) agentMap.set(a.name, a);
  for (const a of global) agentMap.set(a.name, a);
  for (const a of project) agentMap.set(a.name, a);

  return Array.from(agentMap.values());
}

export function getAgent(name: string, cwd: string): AgentConfig | undefined {
  const agents = discoverAgents(cwd);
  return agents.find(a => a.name === name);
}
