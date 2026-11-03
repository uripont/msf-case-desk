import { layerMemory } from './repository'
import { repositoryContract } from './testing/repositoryContract'

repositoryContract('in-memory', () => layerMemory())
