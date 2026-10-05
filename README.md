# VoteQuest

Protótipo React de uma página dividida entre PT · Lula e PL · Flávio. No mobile, o split vira um deck em tela cheia com abas e navegação por swipe. O placar principal é **demonstrativo**: 700.000 votos simulados, com percentuais ilustrativos de 62% e 38%; não são resultados reais. Abaixo dele, os votos reais só aparecem após aprovação manual do Pix.

## Rodar localmente

Requer Node.js 22 ou superior.

```bash
npm install
cp .env.example .env
npm run dev
```

## Pix estático de R$ 10,00 e conferência

O código Pix copia e cola fornecido está configurado. O servidor valida o CRC, exige QR estático e valor fixo de R$ 10,00; o checkout mostra o nome e a cidade do recebedor decodificados do Pix. Confira os dados do recebedor antes de publicar.

Um Pix estático não permite que este site consulte automaticamente se uma transferência foi liquidada. Por isso, após pagar, a pessoa pode enviar o E2E ID do comprovante para uma fila de revisão. A equipe verifica o identificador e o valor no extrato bancário e aprova/rejeita em `/admin`. Só pedidos aprovados entram nos contadores reais. Não coletamos CPF e não enviamos dados ao Telegram.

Para habilitar a área `/admin`, defina `VOTEQUEST_ADMIN_TOKEN` no `.env` com um segredo forte. O token é digitado na página e mantido apenas na memória do navegador. A fila fica em `data/votes.json`: E2E ID e opção ficam associados somente enquanto o pedido está pendente; ao decidir, o vínculo é removido. Permanecem contagens agregadas, hash do E2E ID para impedir reutilização e o status do protocolo anônimo.

## Build e produção

```bash
npm run build
npm start
```

Em produção, use HTTPS e armazenamento persistente para `VOTEQUEST_DATA_FILE`. Não apresente os números demonstrativos como resultados reais. Antes de cobrar contribuições ligadas a uma enquete política, revise as regras legais aplicáveis e informe claramente aos participantes como o dinheiro e os dados de validação serão tratados.
