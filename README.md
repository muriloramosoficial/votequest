# VoteQuest
 .
Protótipo React em uma página com PT · Lula e PL · Flávio. No mobile, a tela vira um deck em tela cheia com abas e swipe. O modo demonstrativo vem ligado e exibe 700.000 votos simulados, claramente rotulados. No modo real, o placar mostra pagamentos Pix aprovados e votos manuais separadamente.

## Rodar localmente

Requer Node.js 22 ou superior.

```bash
npm install
cp .env.example .env
# Preencha SUPABASE_SERVICE_ROLE_KEY e VOTEQUEST_ADMIN_TOKEN no .env local.
npm run dev
```

## Supabase + Vercel

O frontend e as funções HTTP ficam no próprio projeto Vercel; o Supabase fornece o banco. O navegador chama somente URLs relativas `/api/...`. A chave `service_role` nunca deve ir para código cliente, variável `VITE_*`, commit ou resposta da API. A chave anon não é usada pelo app.

1. No Supabase, abra **SQL Editor** e execute `supabase/migrations/20261005000000_votequest.sql`. Ela cria as tabelas, funções transacionais e políticas de acesso.
2. Em **Vercel → Project → Settings → Environment Variables**, configure para os ambientes necessários:
   - `SUPABASE_URL` — URL do projeto Supabase;
   - `SUPABASE_SERVICE_ROLE_KEY` — segredo de servidor, sem prefixo `VITE_`;
   - `VOTEQUEST_ADMIN_TOKEN` — segredo forte para `/admin`;
   - `VOTEQUEST_PIX_CODE` — Pix copia e cola estático de R$ 10,00. O site tem fallback do código público atual.
3. Faça o deploy do projeto Vite no Vercel. `api/[...route].js` publica as rotas serverless e o rewrite mantém o acesso SPA a `/admin`.
4. Confira `https://seu-dominio/api/health`. Para ficar pronto, deve indicar `api: true`, `databaseReady: true`, `adminConfigured: true` e `pixReady: true`.

Se `databaseReady` for falso, confira as variáveis e se a migration foi executada. Se `/api/health` retornar HTML/404, a função não foi publicada no projeto Vercel. Variáveis, por si só, não criam endpoints.

## Pix, revisão e privacidade

O Pix estático não confirma pagamento automaticamente. A pessoa informa o E2E ID do comprovante com consentimento; um administrador confere manualmente no extrato o recebedor e o valor de R$ 10,00 antes de aprovar ou rejeitar. Não coletamos CPF nem enviamos dados ao Telegram. A opção e o E2E ID são apagados da associação após a decisão; permanece o hash antirreuso e o estado do protocolo.

Em `/admin`, o administrador pode alternar entre placar demonstrativo e real, revisar pagamentos e incluir votos manuais com motivo de auditoria. O público vê pagamentos Pix aprovados e inclusões manuais em linhas separadas. Inclusões manuais não são apresentadas como pagamentos confirmados.

Use HTTPS, limite o acesso ao token administrativo e rotacione imediatamente qualquer `service_role` que tenha sido exposta fora do gerenciador de segredos. Não use os números de demonstração como pesquisa ou resultado eleitoral real. Revise as regras legais antes de cobrar contribuições ligadas a uma enquete política.
