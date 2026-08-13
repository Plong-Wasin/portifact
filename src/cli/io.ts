// Interactive prompt helpers. Passwords read from stdin with echo disabled;
// never logged, never accepted as argv.
import process from "node:process";

let pipedReadline: { question(query: string): Promise<string> } | undefined;

async function readLine(prompt: string, silent = false): Promise<string> {
  const { isatty } = await import("node:tty");
  const fd0 = isatty(0);
  process.stdout.write(prompt);
  if (silent && fd0) {
    const { default: readline } = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: undefined, terminal: false });
    // node readline/promises does not natively silence; disable echo via raw mode on tty.
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = "";
    try {
      value = await new Promise<string>((resolve) => {
        const onData = (buf: Buffer) => {
          const text = buf.toString("utf8");
          if (text.includes("\r") || text.includes("\n")) {
            stdin.off("data", onData);
            resolve(value);
          } else if (text === "") {
            process.exit(130);
          } else if (text === "" || text === "\b") {
            value = value.slice(0, -1);
          } else {
            value += text;
          }
        };
        stdin.on("data", onData);
      });
    } finally {
      if (stdin.isTTY) stdin.setRawMode(false);
      rl.close();
    }
    process.stdout.write("\n");
    return value;
  }
  if (!pipedReadline) {
    const { default: readline } = await import("node:readline/promises");
    // Output to /dev/null-style sink: piped input has no echo to suppress, and
    // writing the question prompt to stdout would interleave with piped data.
    // Use a no-op output so nothing (including a password read via pipe) is echoed.
    pipedReadline = readline.createInterface({ input: process.stdin, output: undefined, terminal: false });
  }
  return (await pipedReadline.question("")).trim();
}

export async function promptText(label: string): Promise<string> {
  const value = (await readLine(`${label}: `)).trim();
  if (!value) throw new Error(`${label} is required`);
  return value;
}

export async function promptEmail(): Promise<string> {
  const email = (await readLine("Email: ")).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid email");
  return email;
}

export async function promptPassword(): Promise<string> {
  const password = await readLine("Password (input hidden): ", true);
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  return password;
}

export function fail(message: string): never {
  console.error(JSON.stringify({ event: "cli_error", error: message }));
  process.exit(1);
}
