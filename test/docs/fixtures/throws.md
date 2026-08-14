```ts
import { createMock } from 'mockingham'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile('./openapi.json', 'utf8'))
createMock(doc, { seed: 'docs' }).nope()
```

```console
never printed
```
