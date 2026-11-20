# Instalação do AI Runner Social Media

O app nasce vazio: sem contas conectadas, sem leads e sem histórico.

## Situação em 20/11/2026

| Etapa | Estado |
|---|---|
| Projeto no Supabase (`uopovwfitfklmaiociuk`, São Paulo, plano gratuito) | Feito |
| Estrutura do banco (`schema.sql`) e rotinas agendadas (`rotinas.sql`) | Feito |
| Quatro funções publicadas (`ig-auth`, `ig-webhook`, `ig-api`, `tiktok-auth`) | Feito |
| Tela ligada ao projeto e publicada no GitHub Pages | Feito |
| E-mail `comercial.airunner@gmail.com` liberado como admin | Feito |
| Criar o usuário com senha (passo 1) | Falta |
| Aplicativo na Meta e segredos do Instagram (passo 2) | Falta |
| Chave do Gemini para a IA (passo 3) | Falta |
| Aplicativo no TikTok (passo 4) | Falta |
| Razão social e CNPJ nas páginas legais (passo 5) | Falta |

Endereço do app: https://airunner551.github.io/ai-runner-social-media/

## 1. Criar o seu usuário

No Supabase, em **Authentication › Users › Add user › Create new user**: e-mail `comercial.airunner@gmail.com`, uma senha sua, e marque **Auto Confirm User**. Depois é só entrar no app com esse e-mail e senha.

Para liberar outra pessoa: crie o usuário dela do mesmo jeito e libere o e-mail em Playbook › Equipe (ou na tabela `ig_acesso`). O papel `cliente` enxerga só as contas marcadas para ele.

## 2. Aplicativo na Meta (Instagram)

1. Em developers.facebook.com, crie um app do tipo **Empresa** e adicione o produto **Instagram** com a opção **API setup with Instagram login**.
2. Em **Business login settings**, cadastre o redirecionamento:
   `https://uopovwfitfklmaiociuk.supabase.co/functions/v1/ig-auth/callback`
3. No Supabase, em **Edge Functions › Secrets**, crie:
   - `IG_APP_ID`: o ID do app do Instagram
   - `IG_APP_SECRET`: a chave secreta do app do Instagram
   - `IG_APP_URL`: `https://airunner551.github.io/ai-runner-social-media` (sem barra no fim)
4. Em **Webhooks** (no painel da Meta), aponte para
   `https://uopovwfitfklmaiociuk.supabase.co/functions/v1/ig-webhook`
   O token de verificação já existe: o banco gerou sozinho. Para ver, rode no SQL Editor:
   ```sql
   select valor from public.ig_interno where chave = 'webhook';
   ```
   Assine os campos `comments`, `messages`, `message_reactions`, `messaging_postbacks` e `messaging_seen`.
5. Permissões usadas: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, `instagram_business_content_publish`, `instagram_business_manage_insights`.
6. Enquanto o app estiver em modo de desenvolvimento, só entram contas cadastradas como testadoras (Funções do app › Testadores do Instagram). Para qualquer conta entrar, é preciso passar pela revisão da Meta, que pede a política de privacidade e os termos publicados:
   - https://airunner551.github.io/ai-runner-social-media/privacidade.html
   - https://airunner551.github.io/ai-runner-social-media/termos.html
7. No app, clique em **Conectar conta** e entre com o Instagram do AI Runner.

## 3. Chave do Gemini

Em aistudio.google.com, gere uma chave de API e grave no Supabase como o segredo `GEMINI_API_KEY`. Sem ela o app funciona, mas as sugestões de resposta, roteiros e legendas por IA ficam desligadas.

## 4. Aplicativo no TikTok

1. Em developers.tiktok.com, crie o app e adicione **Login Kit** e **Content Posting API**.
2. Redirecionamento: `https://uopovwfitfklmaiociuk.supabase.co/functions/v1/tiktok-auth/callback`
3. Grave no Supabase os segredos `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`.
4. O TikTok pede verificação do domínio do site: ele entrega um arquivo `.txt` para colocar na raiz deste repositório.
5. Antes da auditoria do TikTok, tudo que o app publica sai privado. Depois de aprovado, passa a sair público.

## 5. Páginas legais

Em `termos.html` e `privacidade.html`, troque o trecho entre colchetes pela razão social e CNPJ da empresa.

## Como foi montado (para refazer em outro projeto)

1. **Banco:** rode `supabase/schema.sql` inteiro no SQL Editor de um projeto novo. Depois rode `supabase/rotinas.sql`, trocando `SEU-PROJETO` pelo código do projeto.
2. **Segredos internos:** o segredo das rotinas agendadas e o token do webhook são gerados pelo próprio banco (tabela `ig_interno`). Ninguém precisa inventar nem copiar.
3. **Funções:** com o Supabase CLI, dentro desta pasta:
   ```bash
   supabase functions deploy ig-auth --project-ref CODIGO --use-api --no-verify-jwt
   ```
   Repita para `ig-webhook`, `ig-api` e `tiktok-auth`. Pelo painel também funciona, colando cada função em um arquivo só (o conteúdo de `_shared` no topo) e desligando **Verify JWT with legacy secret** nas configurações da função: elas fazem a própria conferência de acesso.
4. **Tela:** no começo do script do `index.html`, preencha `SUPA_URL` com o endereço do projeto e `SUPA_ANON` com a chave **publishable** (Project Settings › API Keys). A chave secreta nunca vai na tela.
5. **GitHub Pages:** Settings › Pages › Deploy from a branch › main › / (root).

## Bom saber

- Conta recém-conectada entra no modo **Conteúdo** (agenda, direct, comentários, automações, referências, métricas). O modo **Vendas** pode ser ligado em Contas › Modo, voz e pilares.
- A voz da conta (quem é, como fala) fica em Contas › Modo, voz e pilares. Sem isso a IA se apoia só no nome e na bio do perfil.
- A senha do banco foi gerada pelo Supabase na criação do projeto. O app não usa essa senha; se precisar dela, redefina em Project Settings › Database.
