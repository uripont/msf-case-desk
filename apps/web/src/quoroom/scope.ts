import { Schema } from 'effect'

// NOTE: The identity of the page that started a Command (stage 4 review). A
// Command's answer can arrive after the page was left, entered again for
// another report, or reset. Every Command of the report, share and history
// screens is started with the scope of its Model and its answer carries it
// back; an answer whose scope is not the Model's is dropped. `generation`
// counts the entries of the screen (the parent raises it every time the screen
// is entered or cleared), so even the same report entered twice is told apart.
export const PageScope = Schema.Struct({
  reportId: Schema.String,
  generation: Schema.Int,
})
export type PageScope = typeof PageScope.Type

export const isCurrentPage = (
  model: Readonly<{ reportId: string; generation: number }>,
  scope: PageScope,
): boolean =>
  model.reportId === scope.reportId && model.generation === scope.generation

export const pageScopeOf = (
  model: Readonly<{ reportId: string; generation: number }>,
): PageScope => ({ reportId: model.reportId, generation: model.generation })
