import { PassThrough } from "node:stream";
import { selectSkillAllowlist } from "../../src/cli/skill-selector";

type TtyInput = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(value: boolean): void;
};

const input = new PassThrough() as TtyInput;
input.isTTY = true;
input.isRaw = false;
input.setRawMode = (value) => {
  input.isRaw = value;
};
const output = new PassThrough();
output.on("data", (chunk) => process.stdout.write(chunk));
setTimeout(() => {
  input.write("\u001B[B");
  setTimeout(() => input.write("\r"), 10);
}, 10);

await selectSkillAllowlist(
  [
    {
      identity: { name: "tdd", source: "mattpocock/skills" },
      installed: true,
      initiallySelected: true,
    },
    {
      identity: { name: "unslop", source: "backnotprop/pstack" },
      installed: false,
      initiallySelected: false,
    },
    {
      identity: { name: "focus", source: "example/skills" },
      installed: true,
      initiallySelected: false,
    },
  ],
  undefined,
  { input, output },
);
output.end();
