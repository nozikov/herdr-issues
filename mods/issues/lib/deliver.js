// The only place that starts an agent. `tab.new {task}` hands the task to the agent as one
// more argument, so it can't be lost on a dialog and no shell ever sees it (runtime spike).
// `run` is the runtime's `run(name, args)`; `argv` is the agent's command, passed on unchanged.
export function deliver({ run, space, name, folder, argv, task }) {
  run("tab.new", { space, name, folder, argv, task });
}
