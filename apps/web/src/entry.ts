import { Runtime } from 'foldkit'

import {
  Message,
  Model,
  heroLayoutTransition,
  init,
  subscriptions,
  update,
} from './main'
import { view } from './view'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  viewTransition: heroLayoutTransition,
  container: document.getElementById('root'),
  devTools: {
    Message,
  },
})

Runtime.run(application)
