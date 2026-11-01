/**
 * Telas do Super DELEGÁVEIS (D-PV11, Valdo 2026-10-18 — `prompt_privilegios_interfaces.md`). A LISTA vive no módulo-folha
 * `delegable-interfaces.ts`; o VEREDITO delegado (`delegatedSuperVerdict`) MORREU na costura A1 da auth-api (D-AU6, 2026-10-31): a regra
 * "super passa; usuário da Setes — admin inclusive — só com o verbo marcado pelo Super; outra institution: a tela não existe" é a pilha de
 * views do veredito (`vw_interface_catalog.delegable` + `vw_user_reach`/`vw_user_access` — sql/70 + migration 075), lida pela MESMA peça
 * de todas as guardas. Re-exportada para os consumidores que já importavam daqui.
 */
export { DELEGABLE_SUPER_INTERFACES, isDelegableSuperInterface } from '@shared/auth/delegable-interfaces'
