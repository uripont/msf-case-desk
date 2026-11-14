import { Option } from 'effect'
import { Runtime } from 'foldkit'
import { UrlRequest } from 'foldkit/navigation'

import {
  Message,
  Model,
  init,
  subscriptions,
  update,
} from './main'
import { redactedFragmentOf, withoutFragment } from './route'
import { view } from './view'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  routing: {
    // NOTE: the fragment of an address is a link token; it goes into the
    // Message apart and Redacted (see `withoutFragment`).
    onUrlRequest: request =>
      UrlRequest.match(request, {
        Internal: ({ url }) =>
          Message.ClickedLink({
            request: UrlRequest.Internal({ url: withoutFragment(url) }),
            ...Option.match(redactedFragmentOf(url), {
              onNone: () => ({}),
              onSome: fragment => ({ fragment }),
            }),
          }),
        External: () => Message.ClickedLink({ request }),
      }),
    onUrlChange: url =>
      Message.ChangedUrl({
        url: withoutFragment(url),
        ...Option.match(redactedFragmentOf(url), {
          onNone: () => ({}),
          onSome: fragment => ({ fragment }),
        }),
      }),
  },
  container: document.getElementById('root'),
  devTools: {
    Message,
  },
})

Runtime.run(application)
