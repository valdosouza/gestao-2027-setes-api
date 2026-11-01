/**
 * As chaves (`tb_interface.i18n_key`) que o setes-app usa para ABRIR uma tela — o mapa `interfaceRoutes` do app
 * (`apps/web/lib/app/modules/home/interface_routes.dart`: chave → `/home/<chave>/`). D-PV42 (Valdo 2026-10-20 — fecha a Q-PV50 = (a),
 * `Infra-IA/prompts/prompt_privilegios_interfaces.md`): a guarda do catálogo (D-PV15) congela TODA chave que o código usa para abrir ou
 * montar uma tela — trocar/excluir uma destas na tela Interfaces esconderia a tela de todos (o app cai no `/home/pending/`).
 *
 * Em tempo de execução o setes-api não lê o app: esta lista é a cópia que a guarda usa, e a CERCA (`privilege-catalog-fence.test.ts`)
 * a confere contra o `interfaceRoutes` do app irmão — tela nova no app = entra aqui na mesma entrega (a lista não apodrece).
 */
export const APP_INTERFACE_ROUTE_KEYS: readonly string[] = Object.freeze([
  'bank-accounts', 'bank-charge-agreements', 'bank-slips', 'banks', 'carriers', 'cashier', 'categories', 'cfop', 'checks', 'cities',
  'collaborators', 'contracts', 'countries', 'customers', 'establishment', 'financial-plans', 'institution-interfaces', 'institutions',
  'interface-configs', 'interface-fields', 'interfaces', 'modules', 'order-returns', 'orders', 'payment-types', 'price-lists', 'privileges',
  'providers', 'salesmen', 'service-list', 'service-orders', 'service-tax-rules', 'services', 'settlement-rules', 'settlements', 'states',
  'tax-rules', 'users',
])
