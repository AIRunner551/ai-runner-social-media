-- AI Runner Social Media: rotinas agendadas (publicar o que está agendado, sincronizar, renovar a autorização do Instagram).
-- ANTES de rodar, troque SEU-PROJETO pelo código do projeto no Supabase (está no endereço: https://SEU-PROJETO.supabase.co).
-- O segredo das rotinas não aparece aqui: o banco gerou sozinho na instalação (tabela ig_interno).
create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into public.ig_interno (chave, valor) values ('url', 'https://SEU-PROJETO.supabase.co')
on conflict (chave) do update set valor = excluded.valor;

create or replace function public.ig_chamar(p_path text, p_body jsonb) returns void
language sql security definer set search_path to 'public' as $$
  select net.http_post(url := (select valor from public.ig_interno where chave = 'url') || '/functions/v1/' || p_path,
                       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron', (select valor from public.ig_interno where chave = 'cron')),
                       body := p_body, timeout_milliseconds := 120000);
$$;
revoke all on function public.ig_chamar(text, jsonb) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ig_gerar_filas()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare r record; begin
  for r in select id from public.ig_contas where ativo loop
    perform public.ig_chamar('ig-api/fila/gerar', jsonb_build_object('conta_id', r.id));
  end loop; end $function$;
revoke all on function public.ig_gerar_filas() from public, anon, authenticated;

-- horários em UTC (Brasília = UTC menos 3 horas)
select cron.schedule('ig_agenda_5min', '*/5 * * * *', 'select public.ig_chamar(''ig-api/agenda/executar'', ''{}''::jsonb)');
select cron.schedule('ig_fila_dia', '5 9 * * 1-5', 'select public.ig_gerar_filas()');
select cron.schedule('ig_fluxos_15min', '*/15 11-23 * * 1-6', 'select public.ig_chamar(''ig-api/fluxos/executar'', ''{}''::jsonb)');
select cron.schedule('ig_refresh_token', '0 4 * * 0', 'select public.ig_chamar(''ig-auth/refresh'', ''{}''::jsonb)');
select cron.schedule('ig_sync_hora', '7 * * * *', 'select public.ig_chamar(''ig-api/sync'', ''{}''::jsonb)');
