// D-RS5 / Q-RS11 (gate socrático de 2026-10-21, A-RS9): `npm start` É produção — liga `NODE_ENV=production` por padrão quando o
// ambiente não disser outra coisa, para a exigência do SMTP (`assertMailerReady`) não ficar opt-in num deploy que esqueça a variável.
// Sem dependência nova (cross-env) e funciona no Windows. O único caminho fail-open fica sendo `npm run dev` (tsx watch = dev).
// Para subir o build FORA de produção de propósito: NODE_ENV=development npm start.
'use strict'
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production'
require('../dist/server.js')
