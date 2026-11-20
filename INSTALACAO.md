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
| Aplicativo da Meta: o mesmo do Lidera Social, com o login concluído pelo projeto da Lidera | Feito |
| Convite de testador enviado ao @airunneroficial | Feito, falta aceitar no Instagram (passo 2) |
| Chave da API do Claude, segredo `ANTHROPIC_API_KEY` (passo 3) | Falta |
| Aplicativo no TikTok (passo 4) | Falta |
| Razão social e CNPJ nas páginas legais (passo 5) | Falta |

Endereço do app: https://airunner551.github.io/ai-runner-social-media/

## 1. Criar a sua senha

O Supabase mandou um e-mail de convite para `comercial.airunner@gmail.com`. Abra o link do e-mail: ele leva ao app, que pede para você criar a sua senha. Depois é só entrar com e-mail e senha.

Se o link expirar, abra o app, digite o e-mail e clique em **Esqueci minha senha**: chega um link novo.

Para liberar outra pessoa: em Authentication › Users › Add user › Send invitation, mande o convite, e libere o e-mail em Playbook › Equipe (ou na tabela `ig_acesso`). O papel `cliente` enxerga só as contas marcadas para ele.

## 2. Conectar o Instagram do AI Runner

1. **Aceitar o convite de testador.** Entre no Instagram como @airunneroficial (pelo navegador é mais fácil) e abra https://www.instagram.com/accounts/manage_access/ . Na aba **Convites para testadores**, aceite o convite do aplicativo "Lidera Relatórios-IG". Isso é necessário porque o aplicativo ainda não concluiu a análise da Meta, então só conecta conta com função nele.
2. **Conectar.** No app, clique em **Conectar conta** e entre com o @airunneroficial. Na tela de autorização vai aparecer o nome do aplicativo da Lidera. Ao autorizar, você volta para o app com a conta conectada e a primeira sincronização já rodando.

### Como funciona por baixo

O app usa o aplicativo **Lidera Relatórios** da Meta (ID do app do Instagram `1093483376382075`), que é o mesmo do Lidera Social. A chave secreta desse aplicativo **não foi copiada para cá**: ela continua só no projeto da Lidera, que funciona como hub.

- **Login.** O botão Conectar manda para o hub (`fvcbxorfstqqeewocxkf`), que conclui o login no Instagram e entrega a conta e o token a este projeto em `ig-auth/adotar`, assinados com a chave do hub (ECDSA P-256). O hub não guarda o token das contas deste painel.
- **Tempo real.** A Meta entrega os eventos (direct, comentários) no webhook do hub, que confere a assinatura da Meta e repassa para cá os eventos das contas que não são dele, também assinados.
- **Confiança.** Este projeto só aceita conta ou evento com a assinatura do hub, conferida com a chave pública publicada em `<hub>/ig-auth/chave`. O endereço do hub e o nome deste painel ficam na tabela `ig_interno` (`hub`, `painel`). No hub, a lista de painéis atendidos fica no segredo `IG_PAINEIS`.
- **Dependência.** Se o projeto da Lidera sair do ar, este app continua abrindo e sincronizando de hora em hora, mas não conecta conta nova nem recebe eventos em tempo real.

## Radar de referências

Na tela **Referências**, cada perfil cadastrado num tema entra no radar: seguidores (e quanto cresceu em 7 dias), posts por semana, engajamento médio, taxa de engajamento, views médios dos reels e a lista de posts com os números de cada um. Tudo se atualiza sozinho a cada 6 horas e logo depois de adicionar um perfil. Um post interessante vira referência com um clique ("Guardar como referência"), e dali sai o roteiro de vocês.

Os dados vêm da API oficial da Meta (Business Discovery), que só mostra **contas profissionais** (empresa ou criador). Quem faz a consulta é o projeto da Lidera (hub), com um token do Facebook do usuário do sistema "Lidera Relatórios" do BM01, guardado só lá no segredo `IG_FB_TOKEN`. Este projeto pede ao hub, assinado com a chave dele, e o hub confere a assinatura antes de responder. Estrutura no banco: `supabase/radar.sql`.

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
- Se um dia este app ganhar um aplicativo próprio na Meta: grave `IG_APP_ID` e `IG_APP_SECRET` nos segredos (com a chave secreta presente, o login deixa de passar pelo hub), aponte o webhook dele direto para `.../functions/v1/ig-webhook` e use como token de verificação o valor de `select valor from public.ig_interno where chave = 'webhook';`.
- A senha do banco foi gerada pelo Supabase na criação do projeto. O app não usa essa senha; se precisar dela, redefina em Project Settings › Database.
