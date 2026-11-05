import { execFile } from "node:child_process";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The `exec` shape of the Herdr runtime over execFile: (cmd, args, {cwd}) -> {code, stdout, stderr}.
// Resolves on a non-zero exit too, like the runtime does.
export function nodeExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === "number" ? err.code : 127;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// A throwaway repository with one commit on `main`.
export async function tempRepo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "issues-repo-")));
  const git = (...args) => nodeExec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  await git("init", "-q", "-b", "main");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  return { dir, git };
}
