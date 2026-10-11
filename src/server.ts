import app from './app'
import logger from '@shared/logger/logger'
import {
  assertIsolationLevel, assertRollbackOnTimeoutOff, assertSessionTimeZoneUtc, assertCheckConstraintsEnforced,
} from '@shared/db/connection'
import { detectLockWaitSupport } from '@shared/db/counters'
import { assertIbscbsCatalogSchema } from '@shared/ibscbs-classification'
import { runMigrationsForAllInstitutions } from './migrations/runner'

const PORT = process.env.PORT ?? 3000

async function bootstrap() {
  try {
    logger.info(`Isolamento da conexão: ${await assertIsolationLevel()}`)
    await detectLockWaitSupport()   // Q-A23: FOR UPDATE WAIT n no lock da institution
    logger.info(`innodb_rollback_on_timeout: ${await assertRollbackOnTimeoutOff()}`)   // L7
    logger.info(`Fuso da sessão do banco: ${await assertSessionTimeZoneUtc()}`)          // Q-TZ1
    logger.info(`CHECK do banco: ${await assertCheckConstraintsEnforced()}`)           // D-IB26
    logger.info(`Catálogo IBS/CBS (script 63): ${await assertIbscbsCatalogSchema()}`)   // D-IB36
    logger.info('Iniciando migrations...')
    await runMigrationsForAllInstitutions()
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
