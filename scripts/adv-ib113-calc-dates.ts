/** ADV D-IB113: só LEITURA da Calculadora — o exigeGrupoIbsCbs do par muda com a DATA? (a carga confere UMA data por linha). */
const CALC = 'https://consumo.tributos.gov.br/servico/calcular-tributos-consumo/api/calculadora'
const codes = (process.argv[2] ?? '000001,010001,200028,410014,410999,800001,820001,811001,400001').split(',')
const dates = (process.argv[3] ?? '2026-01-01,2026-11-01,2027-01-01,2027-07-01,2029-01-01,2033-01-01').split(',')
async function main() {
  for (const c of codes) {
    const out: string[] = []
    for (const d of dates) {
      await new Promise(r => setTimeout(r, 350))
      try {
        const res = await fetch(`${CALC}/dados-abertos/classificacoes-tributarias/cbs-ibs/NFS-e/${c}?data=${d}`, { headers: { Accept: 'application/json', Connection: 'close' }, signal: AbortSignal.timeout(30_000) })
        if (!res.ok) { out.push(`${d}:HTTP${res.status}`); continue }
        const x: any = await res.json()
        out.push(`${d}:valido=${x.validoParaSiglaDfeInformado ? 1 : 0},grupo=${x.exigeGrupoIbsCbs === true ? 1 : x.exigeGrupoIbsCbs === false ? 0 : String(x.exigeGrupoIbsCbs)},reg=${x.exigeGrupoTributacaoRegular ? 1 : 0}`)
      } catch (e: any) { out.push(`${d}:ERR ${e.message}`) }
    }
    console.log(c, out.join(' | '))
  }
}
main()
