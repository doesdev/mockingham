# A document whose expected output precedes the code

`assembleProgram` and `expectedOutput` filter by language independently, so
only order WITHIN each language survived — this compared exactly the same as a
document that showed its output in the right place.

```console
ready
```

```ts
import { createMock } from 'mockingham'

const mock = createMock({ openapi: '3.1.0', paths: {} })
console.log(`${typeof mock === 'object' ? 'ready' : 'broken'}`)
```
