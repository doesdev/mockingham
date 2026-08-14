export const mcpDoc = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1.0.0' },
  security: [{ bearerAuth: [] }],
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        summary: 'List all orders',
        description: 'Returns every order the caller can see.',
        tags: ['orders', 'read'],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
        ],
        responses: {
          '200': {
            description: 'Orders',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createOrder',
        summary: 'Place an order',
        tags: ['orders', 'write'],
        security: [{ apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Order' } }
          }
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Order' } }
            }
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string' } }
                }
              }
            }
          }
        },
        callbacks: {
          orderShipped: {
            '{$request.body#/callbackUrl}': {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { orderId: { type: 'string' } }
                      }
                    }
                  }
                },
                responses: { '204': { description: 'ack' } }
              }
            }
          }
        }
      }
    },
    '/orders/{orderId}': {
      get: {
        operationId: 'getOrder',
        summary: 'Fetch one order',
        tags: ['orders', 'read'],
        parameters: [
          {
            name: 'orderId',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 3 }
          }
        ],
        responses: {
          '200': {
            description: 'One order',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Order' } }
            }
          }
        }
      }
    },
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe',
        tags: ['ops'],
        security: [],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } }
              }
            }
          }
        }
      }
    }
  },
  webhooks: {
    orderCreated: {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'string' }, total: { type: 'number' } }
              }
            }
          }
        },
        responses: { '204': { description: 'ack' } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' }
    },
    schemas: {
      Order: {
        type: 'object',
        required: ['id', 'total'],
        properties: {
          id: { type: 'string' },
          total: { type: 'number' },
          note: { type: 'string' }
        }
      }
    }
  }
}
