# A client config under a key other than mcpServers

`checkJsonFence` read `parsed.mcpServers` and returned the moment it was
absent, so a config shaped for a host using a different top-level key received
no argument checking at all - `--nope` is not a flag the CLI accepts.

```ts
import { createMock } from 'mockingham'

const mock = createMock({ openapi: '3.1.0', paths: {} })
console.log(`${typeof mock}`)
```

```console
object
```

```json
{
  "servers": {
    "mockingham": {
      "command": "npx",
      "args": ["-y", "mockingham", "mcp", "./openapi.json", "--nope"]
    }
  }
}
```
