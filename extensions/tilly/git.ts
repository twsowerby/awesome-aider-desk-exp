import { execSync, execFileSync } from 'child_process';

const GIT_TIMEOUT_MS = 10_000;

export interface GitResult {
  success: boolean;
  output?: string;
  error?: string;
}

function runGit(projectDir: string, args: string[]): GitResult {
  try {
    const output = execFileSync('git', args, {
      cwd: projectDir,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output: output.trim() };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function isGitRepo(projectDir: string): boolean {
  return runGit(projectDir, ['rev-parse', '--is-inside-work-tree']).success;
}

export function getChangedFiles(projectDir: string): string[] {
  const unstaged = runGit(projectDir, ['diff', '--name-only']).output?.split('\n') || [];
  const staged = runGit(projectDir, ['diff', '--cached', '--name-only']).output?.split('\n') || [];
  return Array.from(new Set([...unstaged, ...staged])).map(f => f.trim()).filter(Boolean);
}

export function stageFiles(projectDir: string, files: string[] = ['-A']): GitResult {
  return runGit(projectDir, ['add', ...files]);
}

export function commit(projectDir: string, message: string): GitResult {
  const result = runGit(projectDir, ['commit', '-m', message]);
  if (result.success) {
    const hash = runGit(projectDir, ['rev-parse', '--short', 'HEAD']).output;
    if (hash) result.output = hash;
  }
  return result;
}
