import { join } from 'node:path'

// NOTE: Which SQL files the workerd build embeds after the migrations, in
// order. Every one is idempotent (the local database runs them on each start).
//
// demo:  the built-in templates, the account file from `pnpm users:add`, the
//        grants from `pnpm grant-admin --env workerd`, and the synthetic demo
//        cases.
// pilot: the built-in templates, then the grants file if it exists (D21: the
//        first administrator, written by `pnpm grant-admin --env workerd`).
//        No demo cases, and never `users.sql`, which holds demo passwords.
export type WorkerdMode = 'demo' | 'pilot'

export const isWorkerdMode = (value: string): value is WorkerdMode =>
  value === 'demo' || value === 'pilot'

export const workerdImportFiles = (
  mode: WorkerdMode,
  paths: Readonly<{ api: string; local: string }>,
  exists: (file: string) => boolean,
): ReadonlyArray<string> =>
  (mode === 'pilot'
    ? [
        join(paths.api, 'seed/builtin-templates.sql'),
        join(paths.local, 'grants-workerd.sql'),
      ]
    : [
        join(paths.api, 'seed/builtin-templates.sql'),
        join(paths.local, 'users.sql'),
        join(paths.local, 'grants-workerd.sql'),
        join(paths.api, 'seed/demo-cases.sql'),
      ]
  ).filter(exists)
