-- Radar de referências (20/11/2026): dados públicos dos perfis acompanhados, atualizados sozinhos pela API oficial.
alter table public.ig_perfis_ref
  add column if not exists nome text, add column if not exists bio text, add column if not exists site text, add column if not exists foto text,
  add column if not exists seguidores integer, add column if not exists seguindo integer, add column if not exists posts integer,
  add column if not exists eng_medio numeric, add column if not exists taxa_eng numeric, add column if not exists views_medio numeric,
  add column if not exists posts_semana numeric, add column if not exists radar_em timestamptz, add column if not exists radar_erro text;

create table if not exists public.ig_ref_posts (
  conta_id text not null references public.ig_contas(id) on delete cascade,
  id text not null,
  perfil text not null,
  permalink text, tipo text, produto text, legenda text,
  curtidas integer, comentarios integer, views integer, thumb text,
  publicado_em timestamptz, atualizado_em timestamptz default now(),
  primary key (conta_id, id)
);
create index if not exists ig_ref_posts_perfil on public.ig_ref_posts (conta_id, perfil, publicado_em desc);

create table if not exists public.ig_ref_historico (
  conta_id text not null references public.ig_contas(id) on delete cascade,
  perfil text not null,
  data date not null,
  seguidores integer, posts integer, eng_medio numeric, views_medio numeric,
  primary key (conta_id, perfil, data)
);

alter table public.ig_ref_posts enable row level security;
alter table public.ig_ref_historico enable row level security;
drop policy if exists ig_ref_posts_acesso on public.ig_ref_posts;
create policy ig_ref_posts_acesso on public.ig_ref_posts for all
  using ((select public.ig_acesso_total()) or conta_id = any((select public.ig_contas_do_usuario())::text[]))
  with check ((select public.ig_acesso_total()) or conta_id = any((select public.ig_contas_do_usuario())::text[]));
drop policy if exists ig_ref_historico_acesso on public.ig_ref_historico;
create policy ig_ref_historico_acesso on public.ig_ref_historico for all
  using ((select public.ig_acesso_total()) or conta_id = any((select public.ig_contas_do_usuario())::text[]))
  with check ((select public.ig_acesso_total()) or conta_id = any((select public.ig_contas_do_usuario())::text[]));
grant select, insert, update, delete on public.ig_ref_posts, public.ig_ref_historico to authenticated;
grant all on public.ig_ref_posts, public.ig_ref_historico to service_role;

-- atualização automática a cada 6 horas
select cron.unschedule('ig_radar_6h') where exists (select 1 from cron.job where jobname = 'ig_radar_6h');
select cron.schedule('ig_radar_6h', '25 */6 * * *', $$ select public.ig_chamar('ig-api/radar/atualizar', '{}'::jsonb) $$);

-- Radar: histórico completo de posts de cada perfil (20/11/2026)
alter table public.ig_perfis_ref
  add column if not exists hist_cursor text, add column if not exists hist_completo boolean default false, add column if not exists hist_em timestamptz;
create index if not exists ig_ref_posts_views on public.ig_ref_posts (conta_id, perfil, views desc nulls last);
select cron.unschedule('ig_radar_hist') where exists (select 1 from cron.job where jobname = 'ig_radar_hist');
select cron.schedule('ig_radar_hist', '*/30 * * * *', $$ select public.ig_chamar('ig-api/radar/historico', '{}'::jsonb) $$);
