# VoteQuest

Protótipo React de uma página dividida entre PT · Lula e PL · Flávio. O placar visível é **demonstrativo**: 700.000 votos simulados, com percentuais ilustrativos de 62% e 38%. Não são resultados reais de votação ou pesquisa.

## Rodar localmente

Requer Node.js 22 ou superior.

```bash
npm install
cp .env.example .env
npm run dev
```

## Pix estático de R$ 10,00

O QR Pix copia e cola fornecido está configurado como código público de pagamento. O servidor valida o CRC, exige QR estático e valor fixo de R$ 10,00 antes de exibi-lo; também mostra no checkout o nome do recebedor decodificado do próprio Pix. Confira se os dados do recebedor estão corretos antes de publicar.

Esta versão não confirma pagamentos automaticamente, não pede CPF e não envia dados ao Telegram; por isso, o placar continua sendo apenas uma simulação.

## Build e produção

```bash
npm run build
npm start
```

Em produção, use HTTPS. Não apresente os números demonstrativos como resultados reais. Antes de cobrar contribuições ligadas a uma enquete política, revise as regras legais aplicáveis e informe claramente aos participantes como o dinheiro e quaisquer dados serão tratados.
