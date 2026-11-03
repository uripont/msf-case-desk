# Runs Case Desk on plain workerd. Start it with `pnpm workerd` from the
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
  ],
  durableObjectNamespaces = [
    (className = "LocalDatabase", uniqueKey = "case-desk-local-database", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "data"),
);
