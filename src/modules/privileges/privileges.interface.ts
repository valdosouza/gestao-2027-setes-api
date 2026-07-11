/**
 * Tipos do módulo privileges (tb_privilege na setes_central).
 * Espelho no app: apps/web/lib/app/modules/privileges/domain/entity/privilege_entity.dart
 */

export interface PrivilegeRow {
  id:          number
  description: string | null
}
