# VoteQuest

Protótipo React de uma página com PT · Lula e PL · Flávio. No mobile, a tela vira um deck em tela cheia com abas e swipe. O modo demonstrativo vem ligado e exibe 700.000 votos simulados, claramente rotulados. No modo real, o placar mostra pagamentos Pix aprovados e votos manuais separadamente.

## Onde roda o backend

Todo o backend/API deste app é uma **Supabase Edge Function** (`supabase/functions/votequest-api/index.ts`) e o banco é o Postgres do Supabase. O frontend permanece estático no host atual e chama `https://<projeto>.supabase.co/functions/v1/votequest-api` diretamente.

A URL Supabase e a chave `anon`/publishable são configuração pública do frontend. A chave `service_role` é privilegiada: a Edge Function a lê no ambiente seguro do Supabase, com RLS ativada no banco. Nunca a coloque em código cliente, em variável `VITE_*` ou no repositório.

## Inicializar o Supabase

1. No Supabase do projeto `tdxhgqmwzppuqzktaymc`, abra **SQL Editor** e execute `supabase/migrations/20261005000000_votequest.sql`.
2. Em **Edge Functions → Secrets**, defina `VOTEQUEST_ADMIN_TOKEN` com um segredo forte. `VOTEQUEST_PIX_CODE` é opcional: se não definir, a função usa o Pix estático atual de R$ 10,00. A função lê a chave privilegiada do ambiente do próprio Supabase; se seu projeto não disponibilizar `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEYS`, configure-a ali como `VOTEQUEST_SUPABASE_SERVICE_ROLE_KEY`.
3. Publique `supabase/functions/votequest-api/index.ts` como a função **`votequest-api`**. Com o Supabase CLI, no diretório do projeto:

   ```bash
   supabase login
   supabase link --project-ref tdxhgqmwzppuqzktaymc
   supabase functions deploy votequest-api
   ```

   A configuração `supabase/config.toml` mantém a validação JWT da função ativa. O navegador envia a chave pública anon; a chave de serviço permanece no ambiente Edge do Supabase.
4. Teste `https://tdxhgqmwzppuqzktaymc.supabase.co/functions/v1/votequest-api?route=%2Fapi%2Fhealth`. Para ficar pronto, a resposta deve mostrar `api: true`, `databaseReady: true`, `adminConfigured: true` e `pixReady: true`.

A migration cria as tabelas, habilita RLS e restringe leituras/escritas ao backend. Ela também define operações transacionais para aprovação Pix e inclusão manual. A chave `service_role` que o projeto Supabase disponibiliza à Edge Function é usada somente no servidor.

## Desenvolvimento do frontend

```bash
npm install
cp .env.example .env
npm run dev
```

Os valores públicos atuais já estão em `shared/supabase-public.js`; `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no `.env` servem apenas para sobrescrevê-los. Não coloque segredo administrativo ou chave de serviço no `.env` do frontend.

## Pix, revisão e privacidade

Pix estático não confirma pagamento automaticamente. A pessoa informa o E2E ID do comprovante com consentimento; um administrador confere manualmente no extrato o recebedor e o valor de R$ 10,00 antes de aprovar ou rejeitar. Não coletamos CPF nem enviamos dados ao Telegram. Após a decisão, a opção e o E2E ID são apagados da associação; permanece o hash antirreuso e o status do protocolo.

Em `/admin`, o administrador pode alternar o placar demonstrativo/real, revisar pagamentos e incluir votos manuais com motivo de auditoria. O público vê pagamentos Pix aprovados e inclusões manuais em linhas separadas. Inclusões manuais não são apresentadas como pagamentos confirmados.

**Segurança:** a chave `service_role` foi compartilhada na conversa; revogue-a e gere outra antes de usar em produção. Configure segredos somente no Supabase. Não use os números simulados como pesquisa ou resultado eleitoral real; revise as regras legais antes de cobrar contribuições ligadas a uma enquete política.
