import { layerMemory } from './testing/repository-memory'
import { repositoryContract } from './testing/repositoryContract'

repositoryContract('in-memory', () => layerMemory())
