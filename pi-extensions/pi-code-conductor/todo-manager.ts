import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const TODO_FILE = ".pi/conductor-todo.json";

interface TodoItem {
  name: string;
  completed: boolean;
}

interface TodoList {
  items: TodoItem[];
  initialPrompt: string;
}

function ensurePiDir(cwd: string) {
  const piDir = path.join(cwd, ".pi");
  if (!fs.existsSync(piDir)) {
    fs.mkdirSync(piDir, { recursive: true });
  }
}

export function registerTodoTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo-set",
    label: "Set Todo List",
    description: "Initialize or overwrite the current list of todo items.",
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        name: Type.String(),
        completed: Type.Boolean()
      })),
      initialPrompt: Type.String()
    }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      ensurePiDir(ctx.cwd);
      const todoPath = path.join(ctx.cwd, TODO_FILE);
      try {
        fs.writeFileSync(todoPath, JSON.stringify(args, null, 2), "utf-8");
        return { content: [{ type: "text", text: `Todo list set with ${args.items.length} items` }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Failed to set todo list: ${err.message}` }] };
      }
    }
  });

  pi.registerTool({
    name: "todo-get",
    label: "Get Todo List",
    description: "Retrieve the current list of todo items.",
    parameters: Type.Object({}),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      const todoPath = path.join(ctx.cwd, TODO_FILE);
      if (!fs.existsSync(todoPath)) {
        return { content: [{ type: "text", text: "No todo list found" }] };
      }
      try {
        const data: TodoList = JSON.parse(fs.readFileSync(todoPath, "utf-8"));
        let output = `Initial Prompt: ${data.initialPrompt}\n\nTasks:\n`;
        data.items.forEach(item => {
          output += `- [${item.completed ? "x" : " "}] ${item.name}\n`;
        });
        return { content: [{ type: "text", text: output }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Failed to read todo list: ${err.message}` }] };
      }
    }
  });

  pi.registerTool({
    name: "todo-update",
    label: "Update Todo Item",
    description: "Update the completed status of a specific todo item by its name.",
    parameters: Type.Object({
      name: Type.String(),
      completed: Type.Boolean()
    }),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      const todoPath = path.join(ctx.cwd, TODO_FILE);
      if (!fs.existsSync(todoPath)) {
        return { content: [{ type: "text", text: "No todo list found" }] };
      }
      try {
        const data: TodoList = JSON.parse(fs.readFileSync(todoPath, "utf-8"));
        const item = data.items.find(i => i.name === args.name);
        if (!item) {
          return { content: [{ type: "text", text: `Item not found: ${args.name}` }] };
        }
        item.completed = args.completed;
        fs.writeFileSync(todoPath, JSON.stringify(data, null, 2), "utf-8");
        return { content: [{ type: "text", text: `Updated: ${args.name} -> ${args.completed ? "completed" : "not completed"}` }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text", text: `Failed to update todo list: ${err.message}` }] };
      }
    }
  });

  pi.registerTool({
    name: "todo-clear",
    label: "Clear Todo List",
    description: "Delete the current todo list.",
    parameters: Type.Object({}),
    execute: async (toolCallId, args, signal, onUpdate, ctx) => {
      const todoPath = path.join(ctx.cwd, TODO_FILE);
      if (fs.existsSync(todoPath)) {
        fs.unlinkSync(todoPath);
        return { content: [{ type: "text", text: "Todo list cleared" }] };
      }
      return { content: [{ type: "text", text: "No todo list to clear" }] };
    }
  });
}
