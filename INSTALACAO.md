# Instalação do AI Runner Social Media

O app nasce vazio: sem contas conectadas, sem leads e sem histórico. Siga na ordem.

## 1. Supabase (banco, login e servidor)

1. Crie um projeto em supabase.com (região São Paulo). Anote o código do projeto, que aparece no endereço `https://CODIGO.supabase.co`.
2. Em **SQL Editor**, cole e rode o arquivo `supabase/schema.sql` inteiro.
3. Em **Authentication › Users**, crie o seu usuário (e-mail e senha).
4. No SQL Editor, libere o seu e-mail como admin:
   ```sql
   insert into public.ig_acesso (email, nome, papel) values ('SEU_EMAIL', 'Admin', 'admin');
   ```
5. Em **Project Settings › API**, copie a **Project URL** e a chave **anon public**.

## 2. Segredos das funções

Em **Edge Functions › Secrets**, crie:

| Nome | De onde vem |
|---|---|
| `IG_APP_ID` | ID do app do Instagram, no painel da Meta (passo 4) |
| `IG_APP_SECRET` | Chave secreta do app do Instagram |
| `IG_WEBHOOK_VERIFY` | Uma frase que você inventa. A mesma vai no painel da Meta |
| `IG_CRON_SECRET` | Uma senha longa que você inventa. A mesma vai no `rotinas.sql` |
| `IG_APP_URL` | Endereço público do app, sem barra no fim. Ex.: `https://USUARIO.github.io/ai-runner-social-media` |
| `GEMINI_API_KEY` | Chave do Google AI Studio (sugestões de resposta, roteiros e legendas) |
| `TIKTOK_CLIENT_KEY` | Client key do app no TikTok for Developers (passo 5) |
| `TIKTOK_CLIENT_SECRET` | Client secret do app no TikTok |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` já existem sozinhos nas funções.

## 3. Publicar as funções

Com o Supabase CLI instalado e logado, dentro desta pasta:

```bash
supabase functions deploy ig-auth --project-ref CODIGO --use-api --no-verify-jwt
```
```bash
supabase functions deploy ig-webhook --project-ref CODIGO --use-api --no-verify-jwt
```
```bash
supabase functions deploy ig-api --project-ref CODIGO --use-api --no-verify-jwt
```
```bash
supabase functions deploy tiktok-auth --project-ref CODIGO --use-api --no-verify-jwt
```

Depois abra `supabase/rotinas.sql`, troque `SEU-PROJETO` pelo código e `SEGREDO_DO_CRON` pelo valor de `IG_CRON_SECRET`, e rode no SQL Editor. Não suba a versão preenchida para o GitHub.

## 4. Aplicativo na Meta (Instagram)

1. Em developers.facebook.com, crie um app do tipo **Empresa** e adicione o produto **Instagram** com a opção **API setup with Instagram login**.
2. Em **Business login settings**, cadastre o redirecionamento: `https://CODIGO.supabase.co/functions/v1/ig-auth/callback`
3. Em **Webhooks**, aponte para `https://CODIGO.supabase.co/functions/v1/ig-webhook` com o token igual ao `IG_WEBHOOK_VERIFY`. Assine os campos `comments`, `messages`, `message_reactions`, `messaging_postbacks` e `messaging_seen`.
4. Permissões usadas: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, `instagram_business_content_publish`, `instagram_business_manage_insights`.
5. Enquanto o app estiver em modo de desenvolvimento, só entram contas cadastradas como testadoras (Funções do app › Testadores do Instagram). Para qualquer conta entrar, é preciso passar pela revisão da Meta, que pede a política de privacidade (`privacidade.html`) e os termos (`termos.html`) publicados.

## 5. Aplicativo no TikTok

1. Em developers.tiktok.com, crie o app e adicione **Login Kit** e **Content Posting API**.
2. Redirecionamento: `https://CODIGO.supabase.co/functions/v1/tiktok-auth/callback`
3. O TikTok pede verificação do domínio do site: ele entrega um arquivo `.txt` para colocar na raiz deste repositório.
4. Antes da auditoria do TikTok, tudo que o app publica sai privado. Depois de aprovado, passa a sair público.

## 6. A tela

1. Abra `index.html` e preencha, no começo do script, `SUPA_URL` e `SUPA_ANON` com os valores do passo 1.
2. Em `termos.html` e `privacidade.html`, troque o trecho entre colchetes pela razão social e CNPJ da empresa.
3. No GitHub: **Settings › Pages › Deploy from a branch › main › / (root)**.
4. Abra o endereço do Pages, entre com o usuário do passo 1 e clique em **Conectar conta** para ligar o Instagram do AI Runner.

## Bom saber

- Conta recém-conectada entra no modo **Conteúdo** (agenda, direct, comentários, automações, referências, métricas). O modo **Vendas** pode ser ligado em Contas › Modo, voz e pilares.
- Para dar acesso a outra pessoa: crie o usuário em Authentication › Users e libere o e-mail em Playbook › Equipe (ou direto na tabela `ig_acesso`). Papel `cliente` enxerga só as contas marcadas para ele.
- A voz da conta (quem é, como fala) fica em Contas › Modo, voz e pilares. Sem isso a IA se apoia só no nome e na bio do perfil.
