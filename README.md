# AI Runner Social Media

Painel para planejar, agendar e publicar no Instagram e no TikTok, responder direct e comentários, criar automações por palavra-chave e acompanhar métricas, tudo em um só lugar.

## O que tem nesta pasta

| Caminho | O que é |
|---|---|
| `index.html` | O app inteiro (uma página só). É o que o GitHub Pages publica. |
| `assets/` | Logo e ícones do AI Runner. |
| `termos.html`, `privacidade.html` | Páginas exigidas pela Meta e pelo TikTok na revisão do aplicativo. |
| `supabase/schema.sql` | Estrutura do banco: tabelas, regras de acesso, armazenamento e tempo real. |
| `supabase/rotinas.sql` | Rotinas agendadas (publicar o que está na agenda, sincronizar, renovar autorização). |
| `supabase/functions/` | As quatro funções do servidor: `ig-auth`, `ig-webhook`, `ig-api`, `tiktok-auth`. |
| `INSTALACAO.md` | Passo a passo para colocar no ar. |

## Como funciona

- A tela é estática e conversa com um projeto do Supabase (banco, login e funções).
- As contas do Instagram entram pelo login oficial (Instagram API with Instagram Login). Nada de senha de Instagram guardada no app.
- O TikTok entra pelo Login Kit e publica pela Content Posting API.
- Nenhum segredo fica neste repositório. Os segredos ficam nos Secrets das funções, no Supabase.

Comece pelo `INSTALACAO.md`.
