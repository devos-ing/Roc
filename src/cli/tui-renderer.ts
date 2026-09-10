import { stripVTControlCharacters } from "node:util";
import { renderHelpBox } from "./help-box";

/** Extend this list when additional read-only pages are available. */
export const tuiTabs = [
  { id: "welcome", label: "Welcome" },
  { id: "tasks", label: "Tasks" },
] as const;
export type TuiTab = (typeof tuiTabs)[number]["id"];

/** Shares exactly the same tab geometry between rendering and mouse input. */
export function tabTargets() {
  let start = 1;
  return tuiTabs.map((tab, index) => {
    const label = `${index + 1} ${tab.label}`;
    const text = ` ${label} `;
    const target = { ...tab, text, start, end: start + text.length - 1 };
    start += text.length + 1;
    return target;
  });
}

/** Renders setup guidance without requiring settings or a remote snapshot. */
export function renderWelcome(width: number): string {
  return [
    renderHelpBox(
      "Welcome to Roc",
      "Read-only workspace monitor.\nNo scheduler or agents are started here.",
      width,
    ),
    "",
    renderHelpBox(
      "Getting started",
      "Use Tasks to inspect GitHub checkpoints.\nSetup: roc-it onboard\nGitHub login: gh auth login\nRefresh with R after setup; nothing is changed by this monitor.",
      width,
    ),
  ].join("\n");
}

/** Frames a bounded viewport while keeping navigation and recovery status visible. */
export function renderTuiFrame(options: {
  tab: TuiTab;
  body: string;
  status: string;
  width: number;
  rows: number;
  scroll: number;
  revealRows?: { start: number; end: number };
}) {
  const { width, rows } = options;
  /** Strips terminal controls and clips the footer to the available width. */
  const clip = (text: string) => stripVTControlCharacters(text).slice(0, width);
  const tabs = tabTargets()
    .filter((tab) => tab.start <= width)
    .map((tab) => {
      const text = tab.text.slice(0, width - tab.start + 1);
      return tab.id === options.tab ? `\u001B[1;7m${text}\u001B[0m` : text;
    })
    .join("│");
  const header = [tabs, "─".repeat(width)];
  // Limit notices on short screens, leaving at least one row for the page.
  const notice = renderHelpBox("Monitor status", options.status, width).split(
    "\n",
  );
  header.push(...notice.slice(0, Math.max(0, rows - 5)), "");
  const available = Math.max(1, rows - header.length - 1);
  const lines = options.body.split("\n");
  let scroll = Math.min(
    Math.max(0, options.scroll),
    Math.max(0, lines.length - available),
  );
  const reveal = options.revealRows;
  if (reveal !== undefined) {
    if (reveal.start < scroll) scroll = reveal.start;
    else if (reveal.end > scroll + available)
      scroll = Math.min(reveal.start, reveal.end - available);
    scroll = Math.max(0, Math.min(scroll, lines.length - available));
  }
  const footer = clip(
    `${width < 65 ? "Tab/1/2 · R · Q · ? · PgUp/PgDn" : "Tab/1/2 pages · R refresh · Q quit · ? help · PgUp/PgDn scroll"} (${scroll + 1}-${Math.min(lines.length, scroll + available)}/${lines.length})`,
  );
  return {
    text: [...header, ...lines.slice(scroll, scroll + available), footer]
      .slice(0, rows)
      .join("\n"),
    bodyOffset: header.length,
    bodyRows: available,
    scroll,
  };
}
