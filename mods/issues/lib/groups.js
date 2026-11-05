// What a list row and a group header say. Pure: no Node APIs, the Herdr runtime has none.

const HIGH = new Set(["high", "highest", "critical", "blocker"]);

export function isHighPriority(name) {
  return HIGH.has(String(name ?? "").trim().toLowerCase());
}

// Statuses in the order the tasks first show them: that is Jira's own order of the list.
export function groupByStatus(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.state)) groups.set(task.state, []);
    groups.get(task.state).push(task);
  }
  return [...groups].map(([state, inside]) => ({ state, tasks: inside }));
}

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const STEPS = [[365 * DAY, "y"], [30 * DAY, "mo"], [7 * DAY, "w"], [DAY, "d"], [HOUR, "h"], [MINUTE, "m"]];

// Jira writes its offset without a colon, which only some Date parsers take.
export function timeAgo(iso, now) {
  const at = Date.parse(String(iso ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  if (Number.isNaN(at)) return "";
  const age = now - at;
  const step = STEPS.find(([size]) => age >= size);
  return step ? `${Math.floor(age / step[0])}${step[1]} ago` : "just now";
}
