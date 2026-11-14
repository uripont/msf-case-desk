import { type SqlStep, type SqlValue } from "../sql";
// Test-only Worker for plain workerd: exposes the real `LocalDatabase`
// Durable Object and the real `localDatabase` adapter over HTTP, so the SQL
// contract suite can run against workerd's SQLite from Node.
import { type Env, LocalDatabase, localDatabase } from "../workerd";

export { LocalDatabase };

type Call =
  | {
      readonly op: "all" | "first" | "run";
      readonly sql: string;
      readonly values: ReadonlyArray<SqlValue>;
    }
  | { readonly op: "batch"; readonly steps: ReadonlyArray<SqlStep> };

export default {
  fetch: async (
    request: Request,
    env: Env & { readonly HARNESS: string },
  ): Promise<Response> => {
    const headers = { "x-harness": env.HARNESS };
    const name = new URL(request.url).searchParams.get("db") ?? "test";
    const store = localDatabase(env, name);
    const call = (await request.json()) as Call;
    try {
      const body =
        call.op === "batch"
          ? await store.batch(call.steps)
          : call.op === "all"
            ? await store
                .prepare(call.sql)
                .bind(...call.values)
                .all()
            : call.op === "first"
              ? await store
                  .prepare(call.sql)
                  .bind(...call.values)
                  .first()
              : (await store
                  .prepare(call.sql)
                  .bind(...call.values)
                  .run(),
                null);
      return Response.json({ ok: true, body }, { headers });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
        { headers },
      );
    }
  },
};
