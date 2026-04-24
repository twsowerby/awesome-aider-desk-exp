import { execSync, execFileSync } from 'child_process';

const GIT_TIMEOUT_MS = 10_000;

export interface GitResult {
  success: boolean;
  output?: string;
  error?: string;
}

function runGit(projectDir: string, args: string): GitResult {
  try {
    const output = execSync(`git ${args}`, {
      cwd: projectDir,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: output.trim() };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

function parseFileList(result: GitResult): string[] {
  if (!result.success || !result.output) return [];
  return result.output.split('\n').map(f => f.trim()).filter(Boolean);
}

export function isGitRepo(projectDir: string): boolean {
  return runGit(projectDir, 'rev-parse --is-inside-work-tree').success;
}

export function getGitRoot(projectDir: string): string | null {
  const result = runGit(projectDir, 'rev-parse --show-toplevel');
  if (result.success && result.output) {
    return result.output.trim();
  }
  return null;
}

export function getChangedFiles(projectDir: string): string[] {
  const unstaged = parseFileList(runGit(projectDir, 'diff --name-only'));
  const staged = parseFileList(runGit(projectDir, 'diff --cached --name-only'));
  return Array.from(new Set([...unstaged, ...staged]));
}

export function getStagedFiles(projectDir: string): string[] {
  return parseFileList(runGit(projectDir, 'diff --cached --name-only'));
}

// Stage files for commit. If no files specified, stage all changed files (git add -A)
export function stageFiles(projectDir: string, files?: string[]): GitResult {
  try {
    if (!files || files.length === 0) {
      const output = execFileSync('git', ['add', '-A'], {
        cwd: projectDir,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, output: output.trim() };
    }
    const output = execFileSync('git', ['add', ...files], {
      cwd: projectDir,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: output.trim() };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

// Create a commit with the given message
export function commit(projectDir: string, message: string): GitResult {
  try {
    const output = execFileSync('git', ['commit', '-m', message], {
      cwd: projectDir,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Extract short hash
    const hashResult = runGit(projectDir, 'rev-parse --short HEAD');
    if (hashResult.success && hashResult.output) {
      return { success: true, output: hashResult.output };
    }
    return { success: true, output: output.trim() };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: errorMsg };
  }
}

// git diff --cached --quiet exits with 1 if there are staged changes
export function hasStagedChanges(projectDir: string): boolean {
  return !runGit(projectDir, 'diff --cached --quiet').success;
}

export function getDiff(projectDir: string): string | null {
  const parts = [
    runGit(projectDir, 'diff'),
    runGit(projectDir, 'diff --cached'),
  ].filter(r => r.success && r.output).map(r => r.output!);
  return parts.length > 0 ? parts.join('\n') : null;
}

// Generate a fallback commit message when LLM generation fails
export function generateFallbackMessage(agentRole: string, taskDescription: string): string {
  return `chore(${agentRole}): ${taskDescription}`;
}
