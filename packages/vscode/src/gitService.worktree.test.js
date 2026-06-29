import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const installVSCodeMock = () => mock.module('vscode', () => ({
  extensions: {
    getExtension: mock(() => null),
  },
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
}));

installVSCodeMock();

const execFileAsync = promisify(execFile);

const run = async (cwd, args) => {
  await execFileAsync('git', args, { cwd, windowsHide: true });
};

const gitSucceeds = async (cwd, args) => {
  try {
    await execFileAsync('git', args, { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n');

const waitForBootstrapReady = async (getWorktreeBootstrapStatus, directory) => {
  const deadline = Date.now() + 500;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const status = await getWorktreeBootstrapStatus(directory);
    lastStatus = status;
    if (status.status === 'ready') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Worktree bootstrap did not become ready: ${JSON.stringify(lastStatus)}`);
};

const importGitService = async () => {
  installVSCodeMock();
  return import(`./gitService.ts?worktree-service-test=${Date.now()}`);
};

describe('VS Code git service worktree bootstrap', () => {
  let tempDir;
  let previousXdgDataHome;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-vscode-git-'));
    previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(tempDir, 'xdg');
  });

  afterEach(async () => {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }

    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('populates repository files before normal worktree creation returns', async () => {
    const repo = path.join(tempDir, 'repo');
    await fs.promises.mkdir(repo, { recursive: true });
    await run(repo, ['init']);
    await run(repo, ['config', 'user.email', 'test@example.com']);
    await run(repo, ['config', 'user.name', 'Test User']);
    await fs.promises.writeFile(path.join(repo, 'README.md'), 'hello\n', 'utf8');
    await fs.promises.writeFile(path.join(repo, 'opencode.json'), '{"mcp":{}}\n', 'utf8');
    await run(repo, ['add', '.']);
    await run(repo, ['commit', '-m', 'initial']);

    const { createWorktree, getWorktreeBootstrapStatus } = await importGitService();
    const created = await createWorktree(repo, {
      worktreeName: 'feature-files',
      branchName: 'feature-files',
      returnAfterDirectoryCreated: false,
    });

    expect(created.directoryCreated).toBe(true);
    expect(created.bootstrapStatus?.status).toBe('pending');
    expect(created.bootstrapStatus?.phase).toBe('setup');
    expect(
      normalizeLineEndings(await fs.promises.readFile(path.join(created.path, 'README.md'), 'utf8')),
    ).toBe('hello\n');
    expect(
      normalizeLineEndings(await fs.promises.readFile(path.join(created.path, 'opencode.json'), 'utf8')),
    ).toBe('{"mcp":{}}\n');

    await waitForBootstrapReady(getWorktreeBootstrapStatus, created.path);
  }, 10000);

  it('cleans up the worktree and created branch when reset fails after add', async () => {
    const repo = path.join(tempDir, 'repo');
    await fs.promises.mkdir(repo, { recursive: true });
    await run(repo, ['init']);
    await run(repo, ['config', 'user.email', 'test@example.com']);
    await run(repo, ['config', 'user.name', 'Test User']);
    await fs.promises.writeFile(path.join(repo, 'blocked.blocked'), 'blocked\n', 'utf8');
    await run(repo, ['add', 'blocked.blocked']);
    await run(repo, ['commit', '-m', 'add blocked file']);

    await fs.promises.writeFile(path.join(repo, '.gitattributes'), '*.blocked filter=openchamber-fail\n', 'utf8');
    await run(repo, ['add', '.gitattributes']);
    await run(repo, ['commit', '-m', 'enable failing checkout filter']);
    await run(repo, ['config', 'filter.openchamber-fail.required', 'true']);
    await run(repo, ['config', 'filter.openchamber-fail.smudge', 'git openchamber-smudge-fail']);

    const { createWorktree } = await importGitService();
    await expect(createWorktree(repo, {
      worktreeName: 'reset-fail',
      branchName: 'feature/reset-fail',
      returnAfterDirectoryCreated: false,
    })).rejects.toThrow();

    const rootCommit = (await execFileAsync('git', ['rev-list', '--max-parents=0', '--all'], { cwd: repo, windowsHide: true })).stdout.trim();
    const candidateDirectory = path.join(process.env.XDG_DATA_HOME, 'opencode', 'worktree', rootCommit, 'reset-fail');
    expect(fs.existsSync(candidateDirectory)).toBe(false);
    await expect(gitSucceeds(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/feature/reset-fail'])).resolves.toBe(false);
  }, 10000);
});
