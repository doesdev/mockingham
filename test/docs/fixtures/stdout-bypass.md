# A document that writes to stdout without console.log

`assertPrintableLogs` used to scan only for the literal `console.log(`, so any
other route to a stream the harness compares was invisible to it.

```ts
import { createMock } from 'mockingham'

const mock = createMock({ openapi: '3.1.0', paths: {} })
process.stdout.write(String(typeof mock))
```

```console
object
```
