# A document with fabricated output in an inert fence

A `txt` fence is never run, never diffed, and never checked, so this block is
whatever its author felt like typing — indistinguishable to a reader from
output the harness verified.

```ts
import { createMock } from 'mockingham'

const mock = createMock({ openapi: '3.1.0', paths: {} })
console.log(`${typeof mock}`)
```

```console
object
```

```txt
{
  "status": 200,
  "body": "this never ran"
}
```
