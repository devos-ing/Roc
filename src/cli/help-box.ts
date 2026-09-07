import { Writable } from "node:stream";
import { box } from "@clack/prompts";

/** Renders a width-bounded help box using Clack's existing wrapping and borders. */
export function renderHelpBox(
  title: string,
  message: string,
  width = 80,
): string {
  const columns = Math.max(1, Math.floor(width));
  if (columns < 12) return title.slice(0, columns);
  let result = "";
  const output = Object.assign(
    new Writable({
      /** Collects Clack output synchronously for the string renderer. */
      write(chunk, _encoding, callback) {
        result += chunk.toString();
        callback();
      },
    }),
    { columns, isTTY: true },
  );
  box(message, title, {
    output,
    width: "auto",
    rounded: true,
    withGuide: false,
    contentPadding: 1,
    formatBorder: (text) => text,
  });
  output.end();
  return result.trimEnd();
}

/** Places a trailing Next or Retry section in a help box without changing its preceding status. */
export function boxGuidance(message: string, width = 80): string {
  const start = message.search(/^(Next:|Retry:)$/m);
  if (start < 0) return message;
  const [title, ...body] = message.slice(start).split("\n");
  return `${message.slice(0, start)}\n${renderHelpBox(title ?? "Help", body.join("\n"), width)}`;
}
