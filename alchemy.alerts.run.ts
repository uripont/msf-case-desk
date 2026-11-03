import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

// Alerts live in their own stack, so destroying the app never removes them.
// The Workers Free plan has no usage-based alerts; its weekly usage summary
// and CPU usage report are account notifications, on by default. This stack
// adds an e-mail for new errors in the Workers (Workers Issues), the first
// sign that a limit was reached or a deploy broke something.
//
//   ALERT_EMAIL=you@example.org pnpm alerts:plan
//   ALERT_EMAIL=you@example.org pnpm alerts:deploy
export default Alchemy.Stack(
  "TriageDeskAlerts",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const email = yield* Config.String("ALERT_EMAIL");

    const workerErrors = yield* Cloudflare.Alerting.NotificationPolicy("WorkerErrors", {
      name: "Case Desk: new errors in the Workers",
      alertType: "workers_observability_real_time_issue",
      mechanisms: { email: [{ id: email }] },
    });

    return {
      workerErrors: workerErrors.name,
    };
  }),
);
