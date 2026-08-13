import { expect, test } from "bun:test";
import { config, throwingDb } from "./helpers";
import { createApp } from "../src/app";
import { beginDrain } from "../src/runtime";

test("health ready reports draining after beginDrain", async () => {
  const cfg = config();
  const db = throwingDb();
  beginDrain();
  const app = createApp(db, cfg);
  const res = await app.handle(new Request("http://localhost/health/ready"));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: "draining" });
});
