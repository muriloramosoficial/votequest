# VoteQuest

Página React com PT · Lula e PL · Flávio. No mobile, a tela vira um deck em tela cheia com abas e swipe. Cada voto gera um Pix próprio, com um código de referência curto embutido como TxID. O placar mostra exclusivamente os pagamentos Pix de R$ 1,00 localizados no extrato pela conferência manual desse código.

## Onde roda o backend

Todo o backend/API deste app é uma **Supabase Edge Function** (`supabase/functions/votequest-api/index.ts`) e o banco é o Postgres do Supabase. O frontend permanece estático no host atual e chama `https://<projeto>.supabase.co/functions/v1/votequest-api` diretamente.

A função fala com o Postgres apenas por `fetch` no PostgREST (`/rest/v1`), sem SDK: o bundle fica mínimo e não há dependência de resolução de imports em tempo de build.

A URL Supabase e a chave `anon`/publishable são configuração pública do frontend. A chave `service_role` é privilegiada: a Edge Function a lê no ambiente seguro do Supabase, com RLS ativada no banco. Nunca a coloque em código cliente, em variável `VITE_*` ou no repositório.

## Inicializar o Supabase

1. No Supabase do projeto `tdxhgqmwzppuqzktaymc`, abra **SQL Editor** e execute `supabase/migrations/20261005000000_votequest.sql`. O script é idempotente: pode ser executado em um projeto novo ou em um banco que ainda tenha os objetos antigos (ele os remove no bloco de teardown).
2. Em **Edge Functions → Secrets**, defina `VOTEQUEST_ADMIN_TOKEN` com um segredo forte. `VOTEQUEST_PIX_CODE` é opcional: se não definir, a função usa o BR Code base do repositório como modelo (o TxID `***` é substituído pelo código do voto). `VOTEQUEST_VOTE_WINDOW_MINUTES` também é opcional, com padrão de 60, e define o prazo de conferência. A função lê a chave privilegiada do ambiente do próprio Supabase; se seu projeto não disponibilizar `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEYS`, configure-a ali como `VOTEQUEST_SUPABASE_SERVICE_ROLE_KEY`.
3. Publique `supabase/functions/votequest-api/index.ts` como a função **`votequest-api`**. Com o Supabase CLI, no diretório do projeto:

   ```bash
   supabase login
   supabase link --project-ref tdxhgqmwzppuqzktaymc
   supabase functions deploy votequest-api
   supabase secrets set VOTEQUEST_ADMIN_TOKEN=<segredo-forte>
   ```

   A configuração `supabase/config.toml` mantém a validação JWT da função ativa. O navegador envia a chave pública anon; a chave de serviço permanece no ambiente Edge do Supabase.
4. Teste `https://tdxhgqmwzppuqzktaymc.supabase.co/functions/v1/votequest-api?route=%2Fapi%2Fhealth`. Para ficar pronto, a resposta deve mostrar `api: true`, `databaseReady: true`, `adminConfigured: true` e `pixReady: true`.

A migration cria as tabelas, habilita RLS e restringe leituras/escritas ao backend. Ela também define a operação transacional de aprovação Pix, a confirmação do pagador e a expiração por prazo. A chave `service_role` que o projeto Supabase disponibiliza à Edge Function é usada somente no servidor.

## Rotas da API

| Método | Rota | Acesso |
| --- | --- | --- |
| `GET` | `/api/health` | público |
| `GET` | `/api/pix/config` | público |
| `GET` | `/api/pix/results` | público |
| `POST` | `/api/votes/intent` | público |
| `POST` | `/api/votes/intent/confirm` | público |
| `GET` | `/api/votes/status/:protocol` | público |
| `GET` | `/api/admin/votes` | `x-admin-token` |
| `PATCH` | `/api/admin/votes/:protocol` | `x-admin-token` |

## Desenvolvimento do frontend

```bash
npm install
cp .env.example .env
npm run dev
```

Os valores públicos atuais já estão em `shared/supabase-public.js`; `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no `.env` servem apenas para sobrescrevê-los. Não coloque segredo administrativo ou chave de serviço no `.env` do frontend.

## Analytics

O Google Analytics 4 está instalado direto no `index.html` com a tag `G-H2Z6VQ07WQ` (measurement id público, segura para ir no HTML).

Três decisões deliberadas:

- **`/admin` não é medido.** A tela mantém o token administrativo em memória; o `page_view` é enviado manualmente e pulado nesse caminho, então nada daquela tela entra nos reports.
- **Caminhos de recibo não são medidos.** `votequest.com.br/gash3ms2` tem o código no caminho da página, e a URL do recibo não deve vazar para a Google. O teste cobre isso: no recibo o `config` é configurado e nenhum `page_view` sai.
- **Só são enviados `page_view`.** Nada de código de referência, protocolo, Pix ou opção de voto vai para o GA. Nenhum evento customizado de funil foi adicionado — se quiser medir a queda entre "Como votar", "gerou Pix" e "avisei que paguei", é só acrescentar `gtag('event', ...)` nos handlers correspondentes.

Para trocar a tag, edite o `index.html`. Deixá-la em variável de ambiente exigiria placeholder `%VITE_*%`, que quebra o snippet silenciosamente quando a variável não está definida.

Lembre que o GA é bloqueado por boa parte dos ad blockers e extensões de privacidade, então os números ficam subestimados por natureza.

## Pix, revisão e privacidade

Pix não confirma pagamento automaticamente, e CPF não tem relação com Pix: nenhum CPF é coletado e nada é enviado ao Telegram.

Quando o voto começa, a Edge Function gera um código aleatório de 8 caracteres (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, cerca de 8,5×10¹¹ combinações), grava-o no campo TxID `62.05` do BR Code e recalcula o CRC16. O QR serve esse Pix dinâmico e o pagador paga normalmente; o código aparece como "identificador" no comprovante. Cada voto tem o seu próprio QR — um código estático nunca é reaproveitado, porque o app não tem como detectá-lo.

O modal abre sempre em **"Como votar"**, antes de qualquer pagamento: três passos numerados e um bloco explicando por que o código é necessário (o banco só informa o valor recebido, não quem pagou, então o código é o único vínculo entre o Pix e o voto). O Pix e o pedido só são criados quando a pessoa avança para a próxima tela, de modo que abrir e fechar o diálogo não deixa lixo na fila.

Ao tocar em **Já fiz o Pix**, a pessoa apenas confirma, sem digitar nada, e a função registra `confirmed_at`. O administrador busca o código no extrato, confere recebedor e valor de R$ 1,00, e compara o horário do pagamento com a janela do pedido.

A opção do voto fica na fila até a decisão. O código de referência é uma string aleatória sem vínculo com CPF ou documento, e por isso é mantido depois da decisão — era ele, e não a opção, que precisava de limpeza, e a opção agora permanece para que o recibo possa dizer o que foi validado.

### Recibo público: `votequest.com.br/<código>`

Cada código vira a URL de um recibo público: o pagador paga, vê `GASH3MS2` no comprovante e abre `votequest.com.br/gash3ms2`. A página mostra a opção escolhida, o código e o status (`pending`, `review`, `approved`, `rejected` ou `expired`) mais o horário do pedido, da confirmação, do prazo e da decisão.

O recibo tem um botão **Já fiz o Pix**: quem pagou e fechou a tela consegue voltar e registrar a confirmação depois, sem digitar nada. E como o link é do próprio pagador, ele pode mandá-lo a quem quiser provar o voto.

`GET /api/votes/receipt/:code` é público por necessidade (quem tem o link não tem token) e devolve apenas código, opção, status e horários — nunca CPF, nome, dado bancário nem o token administrativo. O código é uma string aleatória de 8 caracteres sobre um alfabeto de 31, o que dá cerca de 8,5×10¹¹ combinações, então não é enumerável. A migration `20261006000000_receipt_url.sql` deixou de apagar a opção na decisão e passou a aceitar `pending` em `votequest_decide_payment`.

### Decisão do administrador

Em `/admin`, a fila mostra o código, um link direto para o recibo do pagador, o horário do pedido, o horário da confirmação e o prazo. **Aprovar e rejeitar funcionam para qualquer item da fila**, inclusive os que o pagador nunca confirmou: antes, `votequest_decide_payment` exigia `status = 'review'`, então quem paga e fecha a tela deixava um pedido que os botões administrativos não conseguiam processar (404) e ele ficava preso até expirar. Pedidos não decididos continuam expirando sozinhos após uma hora e sumindo da fila.

**Segurança:** a chave `service_role` e o token administrativo foram compartilhados na conversa; revogue-os e gere outros antes de usar em produção. Configure segredos somente no Supabase. Revise as regras legais antes de cobrar contribuições ligadas a uma enquete política.