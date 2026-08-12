import type { MediaType, Operation } from '../spec/types.ts'
import type { GenerateOptions } from '../generate/generate.ts'
import { generateValue } from '../generate/generate.ts'
import { createRng } from '../generate/rng.ts'
import type { Rng } from '../generate/rng.ts'
import { selectResponse } from './select.ts'
import type { Selection } from './select.ts'

const JSON_TYPE = 'application/json'

export interface RespondersInput {
  operation: Operation
  request: Request
  staticStatus: number | undefined
  key: string
  generateOptions: GenerateOptions
}

export interface Responders {
  rngFor(label: string): Rng
  selection(): Selection | undefined
  generate(status?: number): unknown
  example(status?: number, name?: string): unknown
  generateOptions: GenerateOptions
}

/**
 * The response helper cluster, with status selection DEFERRED.
 *
 * Selection used to run before the pipeline's stage list, which inverted the
 * stage order the design specifies — auth is stage 3 and selection stage 7 — and
 * leaked operation metadata to unauthenticated callers. Making it lazy lets every
 * stage run first, while `ctx.generate`/`ctx.example` still work inside a user
 * callback because they trigger selection on demand.
 */
export function createResponders(input: RespondersInput): Responders {
  let computed = false
  let cached: Selection | undefined

  const selection = (): Selection | undefined => {
    if (!computed) {
      computed = true
      cached = selectResponse(input.operation, input.request, input.staticStatus)
    }
    return cached
  }

  const rngFor = (label: string): Rng => createRng(`${input.key}|${label}`)

  const mediaFor = (status: number): MediaType | undefined =>
    input.operation.responses.find((response) => response.status === status)
      ?.content[JSON_TYPE]

  const targetFor = (status?: number): number | undefined =>
    status === undefined ? selection()?.spec.status : status

  return {
    rngFor,
    selection,
    generateOptions: input.generateOptions,

    generate(status) {
      const target = targetFor(status)
      if (target === undefined) return undefined
      const media = mediaFor(target)
      if (!media) return undefined
      return generateValue(media.schema, rngFor(String(target)), input.generateOptions)
    },

    example(status, name) {
      const target = targetFor(status)
      if (target === undefined) return undefined
      const media = mediaFor(target)
      if (!media) return undefined
      if (name === undefined) return media.example
      return media.examples?.[name]?.value
    }
  }
}
