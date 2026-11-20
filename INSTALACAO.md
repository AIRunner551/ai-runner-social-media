# Instalação do AI Runner Social Media

O app nasce vazio: sem contas conectadas, sem leads e sem histórico.

## Situação em 20/11/2026

| Etapa | Estado |
|---|---|
| Projeto no Supabase (`uopovwfitfklmaiociuk`, São Paulo, plano gratuito) | Feito |
| Estrutura do banco (`schema.sql`) e rotinas agendadas (`rotinas.sql`) | Feito |
| Quatro funções publicadas (`ig-auth`, `ig-webhook`, `ig-api`, `tiktok-auth`) | Feito |
| Tela ligada ao projeto e publicada no GitHub Pages | Feito |
| Usuário admin `comercial.airunner@gmail.com` convidado por e-mail | Feito, falta você criar a senha (passo 1) |
| Aplicativo da Meta: o mesmo do Lidera Social, com o retorno do AI Runner cadastrado | Feito |
| Segredos `IG_APP_ID` e `IG_APP_URL` | Feito |
| Segredo `IG_APP_SECRET` (passo 2) | Falta |
| Instagram do AI Runner como testador do aplicativo (passo 2) | Falta |
| Chave da API do Claude, segredo `ANTHROPIC_API_KEY` (passo 3) | Falta |
| Aplicativo no TikTok (passo 4) | Falta |
| Razão social e CNPJ nas páginas legais (passo 5) | Falta |

Endereço do app: https://airunner551.github.io/ai-runner-social-media/

## 1. Criar a sua senha

O Supabase mandou um e-mail de convite para `comercial.airunner@gmail.com`. Abra o link do e-mail: ele leva ao app, que pede para você criar a sua senha. Depois é só entrar com e-mail e senha.

Se o link expirar, abra o app, digite o e-mail e clique em **Esqueci minha senha**: chega um link novo.

Para liberar outra pessoa: em Authentication › Users › Add user › Send invitation, mande o convite, e libere o e-mail em Playbook › Equipe (ou na tabela `ig_acesso`). O papel `cliente` enxerga só as contas marcadas para ele.

## 2. Instagram: o mesmo aplicativo da Meta do Lidera Social

O app usa o aplicativo **Lidera Relatórios** (ID do app do Instagram `1093483376382075`). O endereço de retorno do AI Runner já está cadastrado nele e os segredos `IG_APP_ID` e `IG_APP_URL` já estão gravados. Falta:

1. **Chave secreta.** Em developers.facebook.com › Lidera Relatórios › Casos de uso › API do Instagram › Configuração da API com login do Instagram, clique em **Mostrar** na "Chave secreta do app do Instagram" e grave o valor no Supabase do AI Runner, em Edge Functions › Secrets, com o nome `IG_APP_SECRET`.
2. **Testador.** O aplicativo ainda não concluiu a análise da Meta, então só entram contas com função nele. Em Funções do app › Funções, adicione o Instagram do AI Runner como **Testador do Instagram** e aceite o convite no próprio Instagram (Configurações › Apps e sites › Convites para testadores).
3. No app, clique em **Conectar conta** e entre com o Instagram do AI Runner. Na tela de autorização do Instagram vai aparecer o nome do aplicativo da Lidera.

Sobre o tempo real: um aplicativo da Meta tem um único endereço de webhook, e ele aponta para o Lidera Social. O Lidera Social repassa para cá, com a assinatura original, os eventos das contas que não são dele. Sem o `IG_APP_SECRET` gravado aqui, os eventos repassados são guardados, mas as automações não disparam.

## 3. Chave do Claude

A IA do app (sugestão de resposta, roteiros, legendas, análise de referências) usa o Claude pela API da Anthropic.

1. Entre em platform.claude.com com a conta do AI Runner e crie uma **API key**. A API é cobrada por uso e precisa de créditos; a assinatura do aplicativo Claude não vale como chave de API.
2. Grave a chave no Supabase, em Edge Functions › Secrets, com o nome `ANTHROPIC_API_KEY`.

O modelo padrão é o `claude-opus-5-5`. Para trocar, crie o segredo `CLAUDE_MODEL` com o nome do modelo (por exemplo `claude-sonnet-5-5` ou `claude-haiku-5-5`, mais baratos). Sem a chave do Claude o app funciona, mas os botões de IA respondem que a IA não está configurada.

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
- Se um dia este app ganhar um aplicativo próprio na Meta, aponte o webhook dele direto para `.../functions/v1/ig-webhook`; o token de verificação sai de `select valor from public.ig_interno where chave = 'webhook';`.
- A senha do banco foi gerada pelo Supabase na criação do projeto. O app não usa essa senha; se precisar dela, redefina em Project Settings › Database.
