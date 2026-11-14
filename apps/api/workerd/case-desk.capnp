# Runs Quoroom on plain workerd. Start it with `pnpm workerd` from the
# repository root, which builds the bundle and passes the local folders:
#   --directory-path assets=<built web app>
#   --directory-path data=<folder for the SQLite database>
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .caseDesk),
    (name = "assets", disk = (path = "unset")),
    (name = "data", disk = (path = "unset", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:8787", http = (), service = "main")],
);

const caseDesk :Workerd.Worker = (
  modules = [(name = "worker", esModule = embed "dist/worker.js")],
  compatibilityDate = "2026-10-01",
  bindings = [
    (name = "ASSETS", service = "assets"),
    (name = "DATABASE", durableObjectNamespace = "LocalDatabase"),
    # The notification pass (stage 7). `POST /api/tick` needs `TICK_SECRET` (unset: the
    # route answers 404); a host cron calls it, because workerd fires no Cron Triggers.
    # The timings, in minutes, are optional (D12).
    (name = "TICK_SECRET", fromEnvironment = "TICK_SECRET"),
    (name = "NOTIFY_REQUEST_DELAY_MINUTES", fromEnvironment = "NOTIFY_REQUEST_DELAY_MINUTES"),
    (name = "NOTIFY_FIRST_REMINDER_MINUTES", fromEnvironment = "NOTIFY_FIRST_REMINDER_MINUTES"),
    (name = "NOTIFY_FINAL_REMINDER_MINUTES", fromEnvironment = "NOTIFY_FINAL_REMINDER_MINUTES"),
  ],
  durableObjectNamespaces = [
    (className = "LocalDatabase", uniqueKey = "case-desk-local-database", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "data"),
);
