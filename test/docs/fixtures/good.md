# A throwaway document

```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))
const mock = createMock(doc, { seed: 'docs' })
console.log(`operations: ${mock.api.operations.length}`)
```

```console
operations: 4
```

And state carries across blocks:

```ts
console.log('second block')
```

```console
second block
```
