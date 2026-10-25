import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";

export default Alchemy.Stack(
  "TriageDesk",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const path = yield* Path;

    const web = yield* Cloudflare.Website.Foldkit("Web", {
      rootDir: path.resolve(import.meta.dirname, "apps/web"),
    });

    return {
      url: web.url.as<string>(),
    };
  }),
);
