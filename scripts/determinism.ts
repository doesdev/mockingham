import { createMock } from '../src/index.ts'
import { petstore } from '../test/fixtures/petstore.ts'

const mock = createMock(petstore, { seed: 'cross-process' })

for (const path of ['/pets', '/pets/7', '/pets/mine']) {
  const response = await mock.fetch(new Request(`http://mock${path}`))
  console.log(`${path} ${response.status} ${await response.text()}`)
}
