import { BUILT_IN_TEMPLATES } from '@quoroom/domain'

// NOTE: The built-in templates as an import file for an environment that has
// none (the pilot stack, the pilot build for workerd). Insert-if-absent by
// (template ID, version), the same rule as `importBuiltInTemplates`: a redeploy
// changes nothing, and a version an administrator retired stays retired. The
// time is the database's own clock, so the file is deterministic.

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`

const NOW_MS = `CAST(strftime('%s', 'now') AS INTEGER) * 1000`

export const builtinTemplatesSql = (): string =>
  [
    '-- Built-in report templates, generated from packages/domain/src/builtin-templates.ts.',
    '-- Regenerate with: pnpm --filter @quoroom/api templates:sql',
    '-- Insert-if-absent: running it again changes nothing.',
    '',
    ...BUILT_IN_TEMPLATES.flatMap(template => [
      `INSERT INTO templates (id, builtin, created_by, created_at) VALUES (${quote(template.id)}, 1, NULL, ${NOW_MS}) ON CONFLICT DO NOTHING;`,
      `INSERT INTO template_versions (template_id, version, name, short_name, state, definition, created_by, created_at, published_at, published_by, changes, retired_at) VALUES (${quote(template.id)}, ${template.version}, ${quote(template.name)}, ${quote(template.shortName)}, 'published', ${quote(JSON.stringify(template))}, NULL, ${NOW_MS}, ${NOW_MS}, NULL, NULL, NULL) ON CONFLICT DO NOTHING;`,
    ]),
    '',
  ].join('\n')
