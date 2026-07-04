import swaggerJsdoc from 'swagger-jsdoc'

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Setes API',
      version: '1.0.0',
      description: 'API ERP multi-tenant para Gestao 2027',
      contact: {
        name: 'Setes',
        url: 'https://www.setes.com.br',
        email: 'valdo@setes.com.br',
      },
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
      {
        url: 'https://api.setes.com.br',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token para autenticação de clientes',
        },
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            ok: {
              type: 'boolean',
              example: true,
            },
            data: {
              type: 'object',
              description: 'Dados da resposta',
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              example: 'Erro ao processar requisição',
            },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              example: 'ok',
            },
            ts: {
              type: 'string',
              format: 'date-time',
              example: '2026-07-01T15:30:00.000Z',
            },
          },
        },
      },
    },
    security: [
      {
        BearerAuth: [],
      },
    ],
  },
  apis: ['./src/app.ts', './src/shared/swagger/swagger-endpoints.ts'],
}

export const swaggerSpec = swaggerJsdoc(options)
