// Host script: docker compose exec -it app bun run user:reset-password
// Resets a user's password via Better Auth internals (setUserPassword requires
// an admin session, unavailable to the host CLI) and invalidates all existing
// sessions. Password read interactively, never argv/logs.
import { loadConfig } from "../config";
import { createDb } from "../db/client";
import { createAuth } from "../auth";
import { promptEmail, promptPassword, fail } from "./io";

async function main() {
  const config = loadConfig();
  const resources = createDb(config);
  const auth = createAuth(resources.db, config);

  const email = await promptEmail();
  const password = await promptPassword();

  try {
    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail(email);
    if (!found) {
      // Generic message: do not disclose whether the email exists.
      console.log(JSON.stringify({ event: "password_reset", status: "ok" }));
      return;
    }
    await ctx.internalAdapter.updatePassword(found.user.id, await ctx.password.hash(password));
    await ctx.internalAdapter.deleteUserSessions(found.user.id);
    console.log(JSON.stringify({ event: "password_reset", status: "ok", userId: found.user.id }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "reset failed";
    fail(message);
  } finally {
    await resources.sql.close();
  }
}

await main();
