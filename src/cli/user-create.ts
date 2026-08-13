// Host script: docker compose exec -it app bun run user:create
// Creates a "user"-role account with a credential account. Runs as a trusted
// server call (auth.api.createUser bypasses the admin-session check when no
// request/headers are passed). Password is read interactively, never argv/logs.
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { createAuth } from "../auth";
import { promptEmail, promptPassword, promptText, fail } from "./io";

async function main() {
  const config = loadConfig();
  const resources = createDb(config);
  const auth = createAuth(resources.db, config);

  const email = await promptEmail();
  const name = await promptText("Name");
  const password = await promptPassword();

  try {
    const result = await auth.api.createUser({ body: { email, name, password, role: "user" } });
    console.log(JSON.stringify({ event: "user_created", userId: result.user.id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "create failed";
    fail(message);
  } finally {
    await resources.sql.close();
  }
}

await main();
