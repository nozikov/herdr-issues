// Runs a long command to its end in a background terminal of the Herdr runtime, because
// the runtime's `exec` rejects after 30 s. Pure: no Node APIs; `hc` and `sleep` are injected.
// hc: (args: string[]) => Promise<{code, stdout, stderr}>, the `herdr` CLI.

const MAX_POLL_FAILURES = 5;
const fail = (message) => ({ code: null, output: String(message) });

// Resolves { code, output }; code is null when the command didn't exit by itself
// (killed terminal) or the runner itself failed. Never rejects.
export async function runToEnd({ hc, sleep, cwd, argv, onStart }) {
  // One string would be run by hc as a shell command.
  if (!Array.isArray(argv) || argv.length < 2) return fail("runToEnd needs argv with a program and at least one argument");
  try {
    const started = await hc(["run", "--bg", "--json", "--no-parent", "--cwd", cwd, "--", ...argv]);
    let address;
    try {
      address = JSON.parse(started.stdout).address;
    } catch {
      return fail(`Can't read the reply of "run": ${String(started.stdout || started.stderr).trim().slice(0, 200)}`);
    }
    if (typeof address !== "string" || !address) return fail("The reply of \"run\" has no address");
    if (onStart) onStart(address);

    // One failed poll doesn't end the wait: the command keeps running without us.
    let info = null;
    let failures = 0;
    while (!info) {
      try {
        const polled = await hc(["get", address, "--json"]);
        if (polled.code !== 0) throw new Error(String(polled.stderr || polled.stdout).trim() || `exit code ${polled.code}`);
        const parsed = JSON.parse(polled.stdout);
        if (!parsed || typeof parsed !== "object") throw new Error("bad reply");
        failures = 0;
        if (parsed.state === "finished") info = parsed;
      } catch (e) {
        if (++failures >= MAX_POLL_FAILURES)
          return fail(`Lost track of ${address} after ${failures} failed polls (${e?.message ?? e}); its outcome is unknown`);
      }
      if (!info) await sleep(1000);
    }

    // The exit code is known now; a failing read or rm must not take it away.
    const code = info.reason === "exited" && Number.isInteger(info.exit_code) ? info.exit_code : null;
    let output = "";
    try {
      const read = await hc(["read", address, "--lines", "40"]);
      if (read.code === 0) output = read.stdout;
    } catch {
      // nothing to show
    }
    try {
      await hc(["rm", address]);
    } catch {
      // the terminal stays; the result is still good
    }
    return { code, output };
  } catch (e) {
    return fail(e?.message ?? e);
  }
}
