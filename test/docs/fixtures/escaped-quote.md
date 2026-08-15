# A two-argument console.log hidden behind a doubled backslash

The trailing `\\` inside the string used to be misread as escaping the closing
quote, so the scanner never left the string, the depth/comma check never ran,
and this two-argument call was accepted.

```ts
import { createMock } from 'mockingham'

const mock = createMock({ openapi: '3.1.0', paths: {} })
console.log('a\\', typeof mock)
```

```console
a\ object
```
