import app from './app'
import logger from '@shared/logger/logger'
import { runMigrationsForAllTenants } from './migrations/runner'

const PORT = process.env.PORT ?? 3000

async function bootstrap() {
  try {
    logger.info('Iniciando migrations...')
    await runMigrationsForAllTenants()
    logger.info('Migrations concluidas. Subindo servidor...')

    app.listen(PORT, () => {
      logger.info(`Setes API rodando na porta ${PORT}`)
    })
  } catch (err) {
    logger.error('Falha na inicializacao', { err })
    process.exit(1)
  }
}

bootstrap()
