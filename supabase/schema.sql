-- AI Runner Social Media: estrutura do banco (tabelas, regras de acesso, funções, armazenamento e tempo real).
-- Rode UMA vez no SQL Editor de um projeto novo do Supabase. Não traz dados nem segredos.
-- Depois rode rotinas.sql (agendamentos) e siga o INSTALACAO.md.

-- ---------- tabelas ----------
create table if not exists public.ig_contas (
  id text not null,
  username text not null,
  nome text,
  foto text,
  biografia text,
  seguidores integer default 0,
  seguindo integer default 0,
  midias integer default 0,
  ativo boolean default true,
  conectado_em timestamp with time zone default now(),
  token_expira timestamp with time zone,
  ultimo_sync timestamp with time zone,
  erro_sync text,
  webhook_ok boolean default false,
  config jsonb default '{}'::jsonb
);
create table if not exists public.ig_acesso (
  email text not null,
  nome text,
  papel text default 'sdr'::text,
  criado_em timestamp with time zone default now(),
  contas text[]
);
create table if not exists public.ig_leads (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  ig_user_id text,
  username text not null,
  nome text,
  restaurante text,
  cidade text,
  segmento text,
  faixa text,
  fluxo text default 'NS'::text,
  etapa text default 'novo'::text,
  icp text default 'indefinido'::text,
  sinal_calor text,
  conexao text,
  desafio text,
  ganho text,
  whatsapp text,
  email text,
  perfil jsonb default '{}'::jsonb,
  pesquisa text,
  ultimo_toque timestamp with time zone,
  proximo_toque date,
  toques integer default 0,
  aquecimento_dia integer default 0,
  aquecido_em date,
  versao_msg text,
  leadforge_id text,
  conversa_id text,
  responsavel text,
  criado_por text,
  criado_em timestamp with time zone default now(),
  atualizado_em timestamp with time zone default now(),
  comentario_id text,
  passo_atual integer default 0,
  restaurante_ig text
);
create table if not exists public.ig_temas (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  nome text not null,
  descricao text,
  ativo boolean default true not null,
  criado_em timestamp with time zone default now()
);
create table if not exists public.ig_conversas (
  id text not null,
  conta_id text,
  participante_id text,
  participante_username text,
  participante_nome text,
  participante_foto text,
  ultima_msg text,
  ultima_em timestamp with time zone,
  ultima_de_mim boolean,
  nao_lidas integer default 0,
  lead_id uuid,
  camada integer default 1,
  arquivada boolean default false,
  atualizado_em timestamp with time zone default now(),
  lida_em timestamp with time zone
);
create table if not exists public.ig_automacoes (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  nome text not null,
  ativo boolean default false not null,
  midia_id text,
  planejado_id uuid,
  palavras text[] default '{}'::text[] not null,
  respostas_publicas text[] default '{}'::text[] not null,
  dm_texto text default ''::text not null,
  dm_link text,
  uma_vez_por_pessoa boolean default true not null,
  disparos integer default 0 not null,
  ultimo_em timestamp with time zone,
  criado_por text,
  criado_em timestamp with time zone default now(),
  gatilho text default 'comentario'::text not null,
  so_story boolean default false not null,
  max_palavras integer,
  expira_em timestamp with time zone,
  origens text[] default '{comentario}'::text[] not null
);
create table if not exists public.ig_acoes (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  lead_id uuid,
  conversa_id text,
  comentario_id text,
  data date default CURRENT_DATE not null,
  bloco integer default 5,
  tipo text not null,
  titulo text,
  texto text,
  url text,
  status text default 'pendente'::text,
  feita_em timestamp with time zone,
  feita_por text,
  origem text,
  criado_em timestamp with time zone default now(),
  passo_id text,
  automatico boolean default false,
  aprovado boolean default false,
  aprovado_por text,
  aprovado_em timestamp with time zone,
  texto_sugerido text,
  reescrito_em timestamp with time zone,
  origem_adiada date
);
create table if not exists public.ig_automacao_envios (
  id uuid default gen_random_uuid() not null,
  automacao_id uuid,
  conta_id text,
  comentario_id text not null,
  autor_id text,
  autor_username text,
  texto_comentario text,
  dm_ok boolean,
  publica_ok boolean,
  erro text,
  criado_em timestamp with time zone default now(),
  origem text default 'comentario'::text not null
);
create table if not exists public.ig_comentarios (
  id text not null,
  conta_id text,
  midia_id text,
  parent_id text,
  autor_id text,
  autor_username text,
  texto text,
  criado_em timestamp with time zone,
  de_mim boolean default false,
  respondido boolean default false,
  resposta_texto text,
  oculto boolean default false,
  lead_id uuid,
  sugestao_ia text,
  lido boolean default false
);
create table if not exists public.ig_fluxos (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  codigo text not null,
  nome text,
  descricao text,
  ativo boolean default true,
  so_icp boolean default true,
  passos jsonb default '[]'::jsonb,
  atualizado_em timestamp with time zone default now()
);
create table if not exists public.ig_log (
  id bigserial,
  quando timestamp with time zone default now(),
  tipo text,
  conta_id text,
  detalhe jsonb
);
create table if not exists public.ig_mensagens (
  id text not null,
  conversa_id text,
  conta_id text,
  de_mim boolean default false,
  texto text,
  tipo text default 'texto'::text,
  anexos jsonb default '[]'::jsonb,
  criado_em timestamp with time zone,
  lido boolean default false
);
create table if not exists public.ig_midias (
  id text not null,
  conta_id text,
  tipo text,
  produto text,
  legenda text,
  url text,
  thumb text,
  permalink text,
  publicado_em timestamp with time zone,
  curtidas integer default 0,
  comentarios integer default 0,
  alcance integer,
  salvos integer,
  compartilhamentos integer,
  visualizacoes integer,
  interacoes integer,
  insights jsonb default '{}'::jsonb,
  categoria text,
  atualizado_em timestamp with time zone default now()
);
create table if not exists public.ig_perfis_ref (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  tema_id uuid,
  username text not null,
  nota text,
  ultimo_coletado_em timestamp with time zone,
  criado_em timestamp with time zone default now()
);
create table if not exists public.ig_planejados (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  data date not null,
  hora time without time zone,
  tipo text default 'post'::text,
  categoria text,
  titulo text,
  gancho text,
  legenda text,
  roteiro text,
  cta text,
  hashtags text,
  midia_url text,
  status text default 'ideia'::text,
  ig_media_id text,
  publicado_em timestamp with time zone,
  criado_por text,
  criado_em timestamp with time zone default now(),
  atualizado_em timestamp with time zone default now(),
  canais text[] default '{instagram}'::text[] not null,
  creation_id text,
  erro text,
  tentativas integer default 0 not null,
  permalink text,
  tiktok_status text,
  tiktok_url text,
  referencia_id uuid,
  midia_urls text[],
  tiktok_publish_id text,
  tiktok_erro text,
  tiktok_opcoes jsonb
);
create table if not exists public.ig_referencias (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  tema_id uuid,
  perfil text not null,
  code text not null,
  permalink text,
  legenda text,
  transcricao text,
  duracao numeric,
  plays bigint,
  curtidas bigint,
  comentarios bigint,
  publicado_em timestamp with time zone,
  arquivo_local text,
  analise jsonb,
  status text default 'novo'::text not null,
  planejado_id uuid,
  criado_em timestamp with time zone default now()
);
create table if not exists public.ig_respostas (
  id uuid default gen_random_uuid() not null,
  conta_id text,
  grupo text default 'geral'::text,
  titulo text not null,
  texto text not null,
  ordem integer default 0,
  criado_em timestamp with time zone default now()
);
create table if not exists public.ig_seguidores (
  conta_id text not null,
  username text not null,
  nome text,
  primeiro_em date default CURRENT_DATE,
  ultimo_em date default CURRENT_DATE,
  lead_id uuid
);
create table if not exists public.ig_snapshots (
  conta_id text not null,
  data date not null,
  seguidores integer,
  seguindo integer,
  midias integer,
  novos_seguidores integer,
  alcance integer,
  visitas_perfil integer,
  cliques_site integer,
  contas_engajadas integer,
  insights jsonb default '{}'::jsonb
);
create table if not exists public.ig_tokens (
  conta_id text not null,
  access_token text not null,
  expira_em timestamp with time zone,
  permissoes text[],
  atualizado_em timestamp with time zone default now()
);
create table if not exists public.tk_tokens (
  conta_id text not null,
  open_id text,
  nome text,
  avatar text,
  access_token text not null,
  refresh_token text,
  scope text,
  expira_em timestamp with time zone,
  refresh_expira_em timestamp with time zone,
  conectado_em timestamp with time zone default now(),
  atualizado_em timestamp with time zone default now()
);

-- ---------- chaves e restrições ----------
alter table public.ig_acesso add constraint ig_acesso_pkey PRIMARY KEY (email);
alter table public.ig_acoes add constraint ig_acoes_pkey PRIMARY KEY (id);
alter table public.ig_automacao_envios add constraint ig_automacao_envios_pkey PRIMARY KEY (id);
alter table public.ig_automacoes add constraint ig_automacoes_pkey PRIMARY KEY (id);
alter table public.ig_comentarios add constraint ig_comentarios_pkey PRIMARY KEY (id);
alter table public.ig_contas add constraint ig_contas_pkey PRIMARY KEY (id);
alter table public.ig_conversas add constraint ig_conversas_pkey PRIMARY KEY (id);
alter table public.ig_fluxos add constraint ig_fluxos_pkey PRIMARY KEY (id);
alter table public.ig_leads add constraint ig_leads_pkey PRIMARY KEY (id);
alter table public.ig_log add constraint ig_log_pkey PRIMARY KEY (id);
alter table public.ig_mensagens add constraint ig_mensagens_pkey PRIMARY KEY (id);
alter table public.ig_midias add constraint ig_midias_pkey PRIMARY KEY (id);
alter table public.ig_perfis_ref add constraint ig_perfis_ref_pkey PRIMARY KEY (id);
alter table public.ig_planejados add constraint ig_planejados_pkey PRIMARY KEY (id);
alter table public.ig_referencias add constraint ig_referencias_pkey PRIMARY KEY (id);
alter table public.ig_respostas add constraint ig_respostas_pkey PRIMARY KEY (id);
alter table public.ig_seguidores add constraint ig_seguidores_pkey PRIMARY KEY (conta_id, username);
alter table public.ig_snapshots add constraint ig_snapshots_pkey PRIMARY KEY (conta_id, data);
alter table public.ig_temas add constraint ig_temas_pkey PRIMARY KEY (id);
alter table public.ig_tokens add constraint ig_tokens_pkey PRIMARY KEY (conta_id);
alter table public.tk_tokens add constraint tk_tokens_pkey PRIMARY KEY (conta_id);
alter table public.ig_automacao_envios add constraint ig_automacao_envios_automacao_id_comentario_id_key UNIQUE (automacao_id, comentario_id);
alter table public.ig_fluxos add constraint ig_fluxos_conta_id_codigo_key UNIQUE (conta_id, codigo);
alter table public.ig_leads add constraint ig_leads_conta_id_username_key UNIQUE (conta_id, username);
alter table public.ig_perfis_ref add constraint ig_perfis_ref_conta_id_tema_id_username_key UNIQUE (conta_id, tema_id, username);
alter table public.ig_referencias add constraint ig_referencias_conta_id_code_key UNIQUE (conta_id, code);
alter table public.ig_temas add constraint ig_temas_conta_id_nome_key UNIQUE (conta_id, nome);
alter table public.ig_automacoes add constraint ig_automacoes_gatilho_chk CHECK ((gatilho = ANY (ARRAY['comentario'::text, 'direct'::text])));
alter table public.ig_acoes add constraint ig_acoes_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_acoes add constraint ig_acoes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ig_leads(id) ON DELETE CASCADE;
alter table public.ig_automacao_envios add constraint ig_automacao_envios_automacao_id_fkey FOREIGN KEY (automacao_id) REFERENCES ig_automacoes(id) ON DELETE CASCADE;
alter table public.ig_automacoes add constraint ig_automacoes_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_comentarios add constraint ig_comentarios_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_comentarios add constraint ig_comentarios_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ig_leads(id) ON DELETE SET NULL;
alter table public.ig_conversas add constraint ig_conversas_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_conversas add constraint ig_conversas_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ig_leads(id) ON DELETE SET NULL;
alter table public.ig_fluxos add constraint ig_fluxos_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_leads add constraint ig_leads_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_mensagens add constraint ig_mensagens_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES ig_conversas(id) ON DELETE CASCADE;
alter table public.ig_midias add constraint ig_midias_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_perfis_ref add constraint ig_perfis_ref_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_perfis_ref add constraint ig_perfis_ref_tema_id_fkey FOREIGN KEY (tema_id) REFERENCES ig_temas(id) ON DELETE CASCADE;
alter table public.ig_planejados add constraint ig_planejados_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_referencias add constraint ig_referencias_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_referencias add constraint ig_referencias_tema_id_fkey FOREIGN KEY (tema_id) REFERENCES ig_temas(id) ON DELETE SET NULL;
alter table public.ig_respostas add constraint ig_respostas_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_seguidores add constraint ig_seguidores_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_seguidores add constraint ig_seguidores_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES ig_leads(id) ON DELETE SET NULL;
alter table public.ig_snapshots add constraint ig_snapshots_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_temas add constraint ig_temas_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.ig_tokens add constraint ig_tokens_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;
alter table public.tk_tokens add constraint tk_tokens_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES ig_contas(id) ON DELETE CASCADE;

-- ---------- índices ----------
create index if not exists ig_acoes_dia ON public.ig_acoes USING btree (conta_id, data, status);
create index if not exists ig_automacao_envios_autor ON public.ig_automacao_envios USING btree (automacao_id, autor_id);
create index if not exists ig_automacoes_conta ON public.ig_automacoes USING btree (conta_id, ativo);
create index if not exists ig_com_conta ON public.ig_comentarios USING btree (conta_id, criado_em DESC);
create index if not exists ig_conv_conta ON public.ig_conversas USING btree (conta_id, ultima_em DESC);
create index if not exists ig_leads_etapa ON public.ig_leads USING btree (conta_id, etapa);
create index if not exists ig_leads_prox ON public.ig_leads USING btree (conta_id, proximo_toque);
create index if not exists ig_msg_conv ON public.ig_mensagens USING btree (conversa_id, criado_em);
create index if not exists ig_midias_conta_data ON public.ig_midias USING btree (conta_id, publicado_em DESC);
create index if not exists ig_plan_conta ON public.ig_planejados USING btree (conta_id, data);
create index if not exists ig_planejados_agenda ON public.ig_planejados USING btree (status, data, hora);
create index if not exists ig_referencias_tema ON public.ig_referencias USING btree (conta_id, tema_id, plays DESC);
create index if not exists ig_seg_prim ON public.ig_seguidores USING btree (conta_id, primeiro_em DESC);

-- ---------- segredos internos: o banco gera sozinho, ninguém digita ----------
-- 'cron' autentica as rotinas agendadas nas funções; 'webhook' é o token de verificação que vai no painel da Meta.
-- Só o servidor lê esta tabela (sem regra de acesso para usuários).
create table if not exists public.ig_interno (
  chave text primary key,
  valor text not null
);
alter table public.ig_interno enable row level security;
insert into public.ig_interno (chave, valor) values
  ('cron', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('webhook', replace(gen_random_uuid()::text, '-', ''))
on conflict (chave) do nothing;

-- ---------- funções ----------
-- Admin = e-mail liberado em ig_acesso com papel 'admin' (no app original isso vinha de outra tabela, de outro sistema)
create or replace function public.eh_admin() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.ig_acesso a where lower(a.email) = lower(coalesce(auth.jwt()->>'email','')) and a.papel = 'admin');
$$;
CREATE OR REPLACE FUNCTION public.ig_acesso()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.eh_admin()
      or exists (select 1 from public.ig_acesso a where lower(a.email) = lower(coalesce(auth.jwt()->>'email','')));
$function$;
CREATE OR REPLACE FUNCTION public.ig_acesso_total()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.eh_admin()
      or exists (select 1 from public.ig_acesso a
                 where lower(a.email) = lower(coalesce(auth.jwt()->>'email','')) and a.contas is null);
$function$;
CREATE OR REPLACE FUNCTION public.ig_contas_do_usuario()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select a.contas from public.ig_acesso a
                   where lower(a.email) = lower(coalesce(auth.jwt()->>'email','')) limit 1), '{}'::text[]);
$function$;
CREATE OR REPLACE FUNCTION public.ig_inc_comentarios(p_midia text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ update public.ig_midias set comentarios = coalesce(comentarios,0)+1 where id = p_midia; $function$;
CREATE OR REPLACE FUNCTION public.ig_touch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.atualizado_em = now(); return new; end $function$;

-- ---------- gatilhos ----------
drop trigger if exists ig_conversas_touch on public.ig_conversas;
CREATE TRIGGER ig_conversas_touch BEFORE UPDATE ON public.ig_conversas FOR EACH ROW EXECUTE FUNCTION ig_touch();
drop trigger if exists ig_fluxos_touch on public.ig_fluxos;
CREATE TRIGGER ig_fluxos_touch BEFORE UPDATE ON public.ig_fluxos FOR EACH ROW EXECUTE FUNCTION ig_touch();
drop trigger if exists ig_leads_touch on public.ig_leads;
CREATE TRIGGER ig_leads_touch BEFORE UPDATE ON public.ig_leads FOR EACH ROW EXECUTE FUNCTION ig_touch();
drop trigger if exists ig_planejados_touch on public.ig_planejados;
CREATE TRIGGER ig_planejados_touch BEFORE UPDATE ON public.ig_planejados FOR EACH ROW EXECUTE FUNCTION ig_touch();

-- ---------- regras de acesso (cada pessoa só enxerga as contas liberadas para ela) ----------
alter table public.ig_acesso enable row level security;
alter table public.ig_acoes enable row level security;
alter table public.ig_automacao_envios enable row level security;
alter table public.ig_automacoes enable row level security;
alter table public.ig_comentarios enable row level security;
alter table public.ig_contas enable row level security;
alter table public.ig_conversas enable row level security;
alter table public.ig_fluxos enable row level security;
alter table public.ig_leads enable row level security;
alter table public.ig_log enable row level security;
alter table public.ig_mensagens enable row level security;
alter table public.ig_midias enable row level security;
alter table public.ig_perfis_ref enable row level security;
alter table public.ig_planejados enable row level security;
alter table public.ig_referencias enable row level security;
alter table public.ig_respostas enable row level security;
alter table public.ig_seguidores enable row level security;
alter table public.ig_snapshots enable row level security;
alter table public.ig_temas enable row level security;
alter table public.ig_tokens enable row level security;
alter table public.tk_tokens enable row level security;
drop policy if exists ig_acesso_admin on public.ig_acesso;
create policy ig_acesso_admin on public.ig_acesso for all
  using (eh_admin())
  with check (eh_admin());
drop policy if exists ig_acesso_leitura on public.ig_acesso;
create policy ig_acesso_leitura on public.ig_acesso for select
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (lower(email) = lower(COALESCE((auth.jwt() ->> 'email'::text), ''::text)))));
drop policy if exists ig_acoes_acesso on public.ig_acoes;
create policy ig_acoes_acesso on public.ig_acoes for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_automacao_envios_acesso on public.ig_automacao_envios;
create policy ig_automacao_envios_acesso on public.ig_automacao_envios for select
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_automacoes_acesso on public.ig_automacoes;
create policy ig_automacoes_acesso on public.ig_automacoes for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_comentarios_acesso on public.ig_comentarios;
create policy ig_comentarios_acesso on public.ig_comentarios for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_contas_acesso on public.ig_contas;
create policy ig_contas_acesso on public.ig_contas for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_conversas_acesso on public.ig_conversas;
create policy ig_conversas_acesso on public.ig_conversas for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_fluxos_acesso on public.ig_fluxos;
create policy ig_fluxos_acesso on public.ig_fluxos for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_leads_acesso on public.ig_leads;
create policy ig_leads_acesso on public.ig_leads for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_log_acesso on public.ig_log;
create policy ig_log_acesso on public.ig_log for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_mensagens_acesso on public.ig_mensagens;
create policy ig_mensagens_acesso on public.ig_mensagens for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_midias_acesso on public.ig_midias;
create policy ig_midias_acesso on public.ig_midias for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_perfis_ref_acesso on public.ig_perfis_ref;
create policy ig_perfis_ref_acesso on public.ig_perfis_ref for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_planejados_acesso on public.ig_planejados;
create policy ig_planejados_acesso on public.ig_planejados for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_referencias_acesso on public.ig_referencias;
create policy ig_referencias_acesso on public.ig_referencias for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_respostas_acesso on public.ig_respostas;
create policy ig_respostas_acesso on public.ig_respostas for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_seguidores_acesso on public.ig_seguidores;
create policy ig_seguidores_acesso on public.ig_seguidores for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_snapshots_acesso on public.ig_snapshots;
create policy ig_snapshots_acesso on public.ig_snapshots for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));
drop policy if exists ig_temas_acesso on public.ig_temas;
create policy ig_temas_acesso on public.ig_temas for all
  using ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))))
  with check ((( SELECT ig_acesso_total() AS ig_acesso_total) OR (conta_id = ANY (( SELECT ig_contas_do_usuario() AS ig_contas_do_usuario)::text[]))));

-- ---------- armazenamento dos vídeos e imagens a publicar ----------
insert into storage.buckets (id, name, public) values ('ig-midias', 'ig-midias', true) on conflict (id) do nothing;
drop policy if exists ig_midias_up on storage.objects;
create policy ig_midias_up on storage.objects for insert to authenticated
  with check (((bucket_id = 'ig-midias'::text) AND ig_acesso()));
drop policy if exists ig_midias_sel on storage.objects;
create policy ig_midias_sel on storage.objects for select
  using ((bucket_id = 'ig-midias'::text));
drop policy if exists ig_midias_del on storage.objects;
create policy ig_midias_del on storage.objects for delete to authenticated
  using (((bucket_id = 'ig-midias'::text) AND ig_acesso()));

-- ---------- tempo real (direct e comentários aparecem na hora) ----------
alter publication supabase_realtime add table public.ig_comentarios;
alter publication supabase_realtime add table public.ig_conversas;
alter publication supabase_realtime add table public.ig_mensagens;

-- ---------- permissões da API ----------
-- Projetos novos do Supabase não liberam tabelas novas para a API sozinhos. Aqui fica explícito:
-- usuário logado acessa as tabelas do app (as regras acima decidem quais linhas); tokens e segredos, só o servidor.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.ig_acesso, public.ig_acoes, public.ig_automacao_envios, public.ig_automacoes, public.ig_comentarios, public.ig_contas, public.ig_conversas, public.ig_fluxos, public.ig_leads, public.ig_log, public.ig_mensagens, public.ig_midias, public.ig_perfis_ref, public.ig_planejados, public.ig_referencias, public.ig_respostas, public.ig_seguidores, public.ig_snapshots, public.ig_temas to authenticated;
grant all on public.ig_acesso, public.ig_acoes, public.ig_automacao_envios, public.ig_automacoes, public.ig_comentarios, public.ig_contas, public.ig_conversas, public.ig_fluxos, public.ig_interno, public.ig_leads, public.ig_log, public.ig_mensagens, public.ig_midias, public.ig_perfis_ref, public.ig_planejados, public.ig_referencias, public.ig_respostas, public.ig_seguidores, public.ig_snapshots, public.ig_temas, public.ig_tokens, public.tk_tokens to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
revoke all on public.ig_tokens, public.tk_tokens, public.ig_interno from anon, authenticated;
grant execute on function public.eh_admin(), public.ig_acesso(), public.ig_acesso_total(), public.ig_contas_do_usuario() to authenticated, service_role;
grant execute on function public.ig_inc_comentarios(text) to service_role;

-- ---------- primeiro acesso ----------
-- 1) Crie o usuário em Authentication > Users (e-mail e senha).
-- 2) Troque o e-mail abaixo pelo mesmo e-mail e rode esta linha:
-- insert into public.ig_acesso (email, nome, papel) values ('SEU_EMAIL_AQUI', 'Admin', 'admin');
