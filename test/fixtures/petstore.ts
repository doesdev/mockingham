export const petstore = {
  openapi: '3.1.0',
  info: { title: 'Petstore', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List all pets',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
        ],
        responses: {
          '200': {
            description: 'A list of pets',
            headers: { 'x-next': { schema: { type: 'string' } } },
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } }
              }
            }
          }
        }
      },
      post: {
        operationId: 'createPet',
        responses: { '201': { description: 'Created' } }
      }
    },
    '/pets/{petId}': {
      parameters: [
        { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }
      ],
      get: {
        operationId: 'showPetById',
        responses: {
          '200': {
            description: 'One pet',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } }
            }
          },
          '404': { description: 'Not found' }
        }
      }
    },
    '/pets/mine': {
      get: {
        operationId: 'myPet',
        responses: {
          '200': {
            description: 'My pet',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Pet' } }
            }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          tag: { type: 'string' }
        }
      }
    }
  }
}
