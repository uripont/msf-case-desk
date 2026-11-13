import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcGroup, RpcSerialization, RpcServer } from 'effect/rpc'

import {
  QuoroomRpcs,
  type Repository,
  type ReportRepository,
  StorageUnavailable,
} from '@case-desk/domain'

import { AuthenticationLive } from '../handlers'
import { authorHandlers } from './author'
import { authorExtraHandlers } from './authorExtras'
import type { QuoroomClock, QuoroomConfig, QuoroomIds } from './core'
import { makeImageHandler } from './images'
import { reviewerHandlers } from './reviewer'

// NOTE: The iteration 3 RPC, served at its own path next to the iteration 2
// one, which keeps working as it was. Stage 3 switches the apps over.

export const QUOROOM_RPC_PATH = '/api/q/rpc'

type AllHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomRpcs>>

// NOTE: procedures of the later stages (accounts, units, committees,
// templates, theme, notifications, grid, audit, downloads). They are typed and
// declared in the contract, authenticated like the others, and answer
// `StorageUnavailable` until their stage implements them.
const PENDING = [
  'GetMe',
  'SignOut',
  'SetNotificationPreferences',
  'ListAccounts',
  'IssueReset',
  'GrantCapability',
  'RevokeCapability',
  'ListUnits',
  'CreateUnit',
  'UpdateUnit',
  'ListUnitMembers',
  'InviteToUnit',
  'ListReviewers',
  'AddReviewer',
  'UpdateReviewer',
  'ListCommittees',
  'CreateCommittee',
  'UpdateCommittee',
  'ListTemplates',
  'ListPublishedTemplates',
  'GetTemplateVersion',
  'CreateTemplateDraft',
  'SaveTemplateDraft',
  'PublishTemplateVersion',
  'RetireTemplate',
  'GetTheme',
  'UpdateTheme',
  'UpdateCaseFile',
  'AddCoAuthor',
  'ExtendDeadline',
  'RemoveReviewer',
  'GetGrid',
  'ListAuditEvents',
  'ListNotifications',
  'GetUnreadCount',
  'MarkNotificationsRead',
  'GetWhatsAppLink',
  'RecordWhatsAppOpened',
  'GetDownloads',
  'GetApprovalRecordData',
] as const

const notImplemented = () =>
  Effect.fail(new StorageUnavailable({ message: 'not implemented yet' }))

const pending = Object.fromEntries(
  PENDING.map(name => [name, notImplemented]),
) as unknown as Pick<AllHandlers, (typeof PENDING)[number]>

export const QUOROOM_PENDING: ReadonlyArray<string> = PENDING

const handlers = QuoroomRpcs.toLayer(
  Effect.succeed(
    QuoroomRpcs.of({
      ...authorHandlers,
      ...authorExtraHandlers,
      ...reviewerHandlers,
      ...pending,
    }),
  ),
)

// NOTE: the handlers are typed per module with the requirement left open, so
// the requirement the layer really has is stated here: the repository and the
// injected services (the caller comes from the middleware).
export const QuoroomHandlers = handlers as unknown as Layer.Layer<
  Layer.Success<typeof handlers>,
  Layer.Error<typeof handlers>,
  ReportRepository | QuoroomClock | QuoroomIds | QuoroomConfig
>

export type QuoroomDeps = Layer.Layer<
  ReportRepository | QuoroomClock | QuoroomIds | QuoroomConfig
>

export const makeQuoroomRpcHandler = (
  repository: Layer.Layer<Repository>,
  deps: QuoroomDeps,
) =>
  HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: QuoroomRpcs,
      path: QUOROOM_RPC_PATH,
      protocol: 'http',
    }).pipe(
      Layer.provide(QuoroomHandlers),
      Layer.provide(AuthenticationLive),
      Layer.provide(Layer.mergeAll(repository, deps)),
      Layer.provide(RpcSerialization.layerJson),
    ),
    { disableLogger: true },
  )

export const makeQuoroomImageHandler = (
  repository: Layer.Layer<Repository>,
  deps: QuoroomDeps,
) => makeImageHandler(Layer.mergeAll(repository, deps))
