/// <reference types="jest" />
// D-EA9/D-EA18 (Onda 4 do endurecer): a suíte grava senha no peso MAIS LEVE da lista aceita (`N=2^14, r=8, p=1` — ≈ 190 ms na máquina do
// dev, contra 0,4 a 1,3 s do vigente `p=3`): centenas de testes passam por login e cadastro, e o peso vigente sozinho somaria minutos de CPU.
// A semântica não muda — o peso vem do VALOR gravado e o vigente decide o recálculo (H10). O teste da peça
// (`password-scrypt-d-ea9.test.ts`) volta ao `SCRYPT_CURRENT` real para provar o formato e o peso de produção (H1) e a medição (H8) roda
// fora do jest (`scripts/measure-scrypt.ts`).
import { setCurrentScryptParamsForTests } from '../shared/auth/password'

setCurrentScryptParamsForTests({ N: 2 ** 14, r: 8, p: 1 })
