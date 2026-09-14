import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
vi.mock("./observability/sentry.js", () => ({
  initSentry: vi.fn(),
  captureError: vi.fn(),
}));
const readyMock = vi.hoisted(() => vi.fn());
vi.mock("./jobs/operations.js", () => ({ checkReadiness: readyMock }));
import { buildServer, isMainModule } from "./server.js";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function server() {
  const app = buildServer();
  apps.push(app);
  return app;
}

describe("production HTTP boundaries", () => {
  it("can be imported without opening a listener", () => {
    expect(isMainModule).toBe(false);
  });
  it("does not expose internal details in 5xx responses", async () => {
    const app = server();
    app.get("/test-failure", async () => {
      throw new Error("secret-database-host password=do-not-expose");
    });
    const response = await app.inject({ method: "GET", url: "/test-failure" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("secret-database-host");
    expect(response.body).not.toContain("password");
    expect(response.json().requestId).toBeTruthy();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  }, 15000);
  it("treats malformed JSON as a client error", async () => {
    const app = server();
    app.post("/test-json", async (request) => request.body);
    const response = await app.inject({
      method: "POST",
      url: "/test-json",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
  });
  it("keeps liveness available without exposing configuration", async () => {
    const response = await server().inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

it.each([false, true])(
  "readiness responds to dependency state %s",
  async (ready) => {
    readyMock.mockResolvedValue(ready);
    const response = await server().inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(ready ? 200 : 503);
    expect(response.json()).toEqual({ ok: ready });
  },
);
it("readiness hides database error details", async () => {
  readyMock.mockRejectedValue(new Error("private database connection detail"));
  const response = await server().inject({ method: "GET", url: "/readyz" });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ ok: false });
});
