// Edge Function: ig-api (AI Runner Social Media)
// Rotas (todas POST com JSON; auth = JWT do usuário com acesso OU header x-cron = IG_CRON_SECRET):
//   /sync            {conta_id?, completo?}   perfil, mídias+insights, snapshot do dia, comentários, conversas
//   /fila/gerar      {conta_id, data?}        monta a fila do dia (rotina do playbook)
//   /comentario/responder {id, texto}  /comentario/ocultar {id, ocultar}
//   /dm/enviar       {conversa_id, texto}
//   /lead/pesquisar  {conta_id, username}      business_discovery + IA (triagem ICP, conexão, boas-vindas)
//   /ia/sugerir      {tipo:'dm'|'comentario', id}
//   /ia/classificar_midias {conta_id}          categoriza posts no motor 3x2
// Deploy: supabase functions deploy ig-api --project-ref SEU-PROJETO --use-api --no-verify-jwt
import { admin, agoraBR, CORS, CRON_SECRET, ehDaCasa, gemini, graph, graphPost, hoje, json, log, podeConta, saudacao, SUPABASE_URL, tokenDaConta, usuarioAutorizado } from "../_shared/ig.ts";
import { ETAPAS, limiteDiario, PLAYBOOK_IA, STORY_CAPTURA } from "../_shared/playbook.ts";
import { parseJSON } from "../_shared/ig.ts";
import { tkCriador, tkEnviarVideo, TkOpcoes, tkStatus, tkToken } from "../_shared/tiktok.ts";
import { BLOCO_POR_FLUXO, FLUXOS_PADRAO, Fluxo, Passo, preencher, proximaMensagem, temPlaceholder, TIPO_PARA_ACAO } from "../_shared/fluxos.ts";

type Row = Record<string, unknown>;
const db = admin();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.split("/ig-api")[1] || "/";
  if (rota === "/" || rota === "") return json({ ok: true, app: "AI Runner Social Media", rotas: ["/sync", "/fila/gerar", "/comentario/responder", "/comentario/ocultar", "/dm/enviar", "/lead/pesquisar", "/ia/sugerir", "/ia/classificar_midias"] });

  const cron = req.headers.get("x-cron") === CRON_SECRET && !!CRON_SECRET;
  const user = cron ? { email: "cron", id: "cron", contas: null as string[] | null } : await usuarioAutorizado(req);
  if (!user) return json({ erro: "não autorizado" }, 401);
  const body: Row = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  // acesso por conta: quem tem lista de contas (cliente) só mexe nelas
  if (user.contas && rota !== "/fluxos/padrao") {
    const conta = await contaDoPedido(rota, body);
    if (!conta || !podeConta(user, conta)) return json({ erro: "sem acesso a esta conta" }, 403);
  }

  try {
    switch (rota) {
      case "/sync": return json(await sync(body, user.email));
      case "/fila/gerar": return json(await gerarFila(String(body.conta_id), String(body.data || hoje())));
      case "/comentario/responder": return json(await responderComentario(String(body.id), String(body.texto), user.email));
      case "/comentario/conferir": return json(await conferirComentarios(String(body.conta_id)));
      case "/comentario/ocultar": return json(await ocultarComentario(String(body.id), body.ocultar !== false));
      case "/dm/enviar": return json(await enviarDM(String(body.conversa_id), String(body.texto), user.email));
      case "/lead/pesquisar": return json(await pesquisarLead(String(body.conta_id), String(body.username), user.email, body));
      case "/ia/sugerir": return json(await sugerir(String(body.tipo), String(body.id)));
      case "/ia/classificar_midias": return json(await classificarMidias(String(body.conta_id)));
      case "/ia/conteudo": return json(await criarConteudo(body));
      case "/publicar": return json(await publicar(body, user.email));
      case "/agenda/executar": return json(await executarAgenda(body));
      case "/tiktok/executar": return json(await executarTikTok(body));
      case "/tiktok/criador": return json(await tiktokCriador(String(body.conta_id || "")));
      case "/tiktok/publicar": return json(await tiktokPublicar(String(body.planejado_id || ""), user.email));
      case "/tiktok/status": return json(await tiktokStatus(String(body.planejado_id || "")));
      case "/ref/analisar": return json(await analisarReferencias(String(body.conta_id || ""), Number(body.limite) || 5));
      case "/ref/roteiro": return json(await roteiroDaReferencia(String(body.referencia_id), user.email));
      case "/fluxos/padrao": return json(FLUXOS_PADRAO);
      case "/fluxos/executar": return json(await executarFluxos(String(body.conta_id || "")));
      case "/fluxos/reescrever": return json(await reescreverTextos(String(body.conta_id || ""), body.acao_id ? String(body.acao_id) : null, !!body.todas, Number(body.limite) || 6));
      case "/fluxos/entrar": return json(await entrarNoFluxo(String(body.lead_id), user.email));
      default: return json({ erro: "rota desconhecida" }, 404);
    }
  } catch (e) {
    await log("erro", (body.conta_id as string) || null, { rota, erro: String(e) });
    return json({ erro: String(e) }, 500);
  }
});

// De qual conta é o pedido: vem no corpo (conta_id) ou sai do registro citado (comentário, conversa, lead, publicação...).
async function contaDoPedido(rota: string, body: Row): Promise<string | null> {
  if (body.conta_id) return String(body.conta_id);
  const de = async (tabela: string, id: unknown) => id ? (((await db.from(tabela).select("conta_id").eq("id", String(id)).maybeSingle()).data?.conta_id as string) || null) : null;
  if (body.conversa_id) return de("ig_conversas", body.conversa_id);
  if (body.planejado_id) return de("ig_planejados", body.planejado_id);
  if (body.referencia_id) return de("ig_referencias", body.referencia_id);
  if (body.lead_id) return de("ig_leads", body.lead_id);
  if (body.acao_id) return de("ig_acoes", body.acao_id);
  if (body.id) return de(rota.startsWith("/comentario") || body.tipo === "comentario" ? "ig_comentarios" : "ig_conversas", body.id);
  return null;
}

// ======================= SYNC =======================
async function sync(body: Row, quem: string) {
  const ids = body.conta_id ? [String(body.conta_id)] : ((await db.from("ig_contas").select("id").eq("ativo", true)).data || []).map((c) => c.id as string);
  const out: Row = {};
  for (const id of ids) {
    try {
      const tok = await tokenDaConta(id);
      if (!tok) { out[id] = "sem token"; continue; }
      const r: Row = {};
      // perfil
      const me = await graph("me", tok, { fields: "username,name,profile_picture_url,followers_count,follows_count,media_count,biography" });
      await db.from("ig_contas").update({ username: me.username, nome: me.name, foto: me.profile_picture_url, biografia: me.biography, seguidores: me.followers_count, seguindo: me.follows_count, midias: me.media_count, ultimo_sync: new Date().toISOString(), erro_sync: null }).eq("id", id);
      // snapshot do dia (insights da conta)
      r.snapshot = await snapshotConta(id, tok, me);
      // mídias
      r.midias = await syncMidias(id, tok, body.completo === true);
      // comentários das últimas mídias
      r.comentarios = await syncComentarios(id, tok);
      try { r.comentarios_apagados = (await conferirComentarios(id)).apagados; } catch (e) { await log("erro", id, { onde: "conferirComentarios", erro: String(e).slice(0, 200) }); }
      // conversas
      r.conversas = await syncConversas(id, tok, body.completo === true);
      // quem ficou gravado com número no lugar do @: tenta de novo (no pedido manual, ou uma vez por hora no automático)
      if (quem !== "cron" || agoraBR().getMinutes() < 15) { try { const nn = await resolverNomes(id, tok); if (nn) r.nomes_resolvidos = nn; } catch (e) { await log("erro", id, { onde: "resolverNomes", erro: String(e).slice(0, 200) }); } }
      // token a vencer em < 10 dias: renova
      const { data: t } = await db.from("ig_tokens").select("expira_em").eq("conta_id", id).maybeSingle();
      if (t?.expira_em && new Date(t.expira_em).getTime() - Date.now() < 10 * 864e5) {
        await fetch(`${SUPABASE_URL}/functions/v1/ig-auth/refresh`, { method: "POST", headers: { "x-cron": CRON_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ conta_id: id }) }).catch(() => {});
        r.token = "renovado";
      }
      out[id] = r;
      await log("sync", id, { por: quem, ...r });
    } catch (e) {
      out[id] = String(e);
      await db.from("ig_contas").update({ erro_sync: String(e).slice(0, 300), ultimo_sync: new Date().toISOString() }).eq("id", id);
      await log("erro", id, { onde: "sync", erro: String(e) });
    }
  }
  return out;
}

async function snapshotConta(id: string, tok: string, me: Row) {
  const data = hoje();
  const ins: Row = {};
  const pega = async (metric: string, extra: Record<string, string>) => {
    try {
      const j = await graph(`${id}/insights`, tok, { metric, period: "day", ...extra });
      for (const m of j.data || []) {
        const v = m.total_value?.value ?? m.values?.[m.values.length - 1]?.value;
        ins[m.name] = v;
      }
    } catch (e) { ins[`erro_${metric.split(",")[0]}`] = String(e).slice(0, 120); }
  };
  await pega("reach,profile_views,website_clicks,accounts_engaged,total_interactions", { metric_type: "total_value" });
  await pega("follower_count", {});
  // ontem, para calcular novos seguidores quando follower_count não vier
  const { data: ontem } = await db.from("ig_snapshots").select("seguidores").eq("conta_id", id).lt("data", data).order("data", { ascending: false }).limit(1).maybeSingle();
  const novos = ins.follower_count ?? (ontem ? Number(me.followers_count) - Number(ontem.seguidores) : null);
  await db.from("ig_snapshots").upsert({
    conta_id: id, data, seguidores: me.followers_count, seguindo: me.follows_count, midias: me.media_count,
    novos_seguidores: novos, alcance: ins.reach ?? null, visitas_perfil: ins.profile_views ?? null, cliques_site: ins.website_clicks ?? null,
    contas_engajadas: ins.accounts_engaged ?? null, insights: ins,
  });
  return { data, novos, alcance: ins.reach ?? null };
}

async function syncMidias(id: string, tok: string, completo: boolean) {
  let n = 0;
  let next: string | null = `${id}/media`;
  let params: Record<string, string> = { fields: "id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count", limit: "25" };
  let paginas = 0;
  while (next && paginas < (completo ? 8 : 1)) {
    const j = await graph(next, tok, params);
    for (const m of j.data || []) {
      const ins = await insightsMidia(m, tok);
      await db.from("ig_midias").upsert({
        id: m.id, conta_id: id, tipo: m.media_type, produto: m.media_product_type, legenda: m.caption || "", url: m.media_url, thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : null),
        permalink: m.permalink, publicado_em: m.timestamp, curtidas: m.like_count ?? 0, comentarios: m.comments_count ?? 0,
        alcance: ins.reach ?? null, salvos: ins.saved ?? null, compartilhamentos: ins.shares ?? null, visualizacoes: ins.views ?? ins.plays ?? null, interacoes: ins.total_interactions ?? null,
        insights: ins, atualizado_em: new Date().toISOString(),
      });
      n++;
    }
    next = j.paging?.next || null; params = {}; paginas++;
  }
  return n;
}

async function insightsMidia(m: Row, tok: string): Promise<Row> {
  const out: Row = {};
  const ehReel = m.media_product_type === "REELS";
  const metric = ehReel ? "reach,saved,shares,views,total_interactions,likes,comments" : (m.media_type === "CAROUSEL_ALBUM" ? "reach,saved,shares,total_interactions,views" : "reach,saved,shares,total_interactions,views");
  try {
    const j = await graph(`${m.id}/insights`, tok, { metric });
    for (const x of j.data || []) out[x.name] = x.values?.[0]?.value ?? x.total_value?.value;
  } catch (e) { out.erro = String(e).slice(0, 100); }
  return out;
}

async function syncComentarios(id: string, tok: string) {
  const { data: midias } = await db.from("ig_midias").select("id").eq("conta_id", id).gt("comentarios", 0).order("publicado_em", { ascending: false }).limit(15);
  let n = 0;
  for (const m of midias || []) {
    try {
      const j = await graph(`${m.id}/comments`, tok, { fields: "id,text,username,timestamp,from,hidden,replies{id,text,username,timestamp,from}", limit: "50" });
      for (const c of j.data || []) {
        const de_mim = c.from?.id === id;
        const respondido = (c.replies?.data || []).some((r: Row) => (r.from as Row)?.id === id);
        const resp = (c.replies?.data || []).find((r: Row) => (r.from as Row)?.id === id) as Row | undefined;
        await db.from("ig_comentarios").upsert({ id: c.id, conta_id: id, midia_id: m.id, autor_id: c.from?.id, autor_username: c.username || c.from?.username, texto: c.text, criado_em: c.timestamp, de_mim, oculto: !!c.hidden, ...(respondido ? { respondido: true, resposta_texto: resp?.text as string } : {}) }, { onConflict: "id" });
        n++;
        for (const r of c.replies?.data || []) {
          await db.from("ig_comentarios").upsert({ id: r.id, conta_id: id, midia_id: m.id, parent_id: c.id, autor_id: r.from?.id, autor_username: r.username || r.from?.username, texto: r.text, criado_em: r.timestamp, de_mim: r.from?.id === id, lido: true }, { onConflict: "id" });
        }
      }
    } catch (e) { await log("erro", id, { onde: "comentarios", midia: m.id, erro: String(e).slice(0, 200) }); }
  }
  return n;
}

async function syncConversas(id: string, tok: string, completo: boolean) {
  let n = 0;
  try {
    // conta com muito direct estoura o limite do Graph ("reduce the amount of data"): tenta de novo com janelas menores
    const pedir = (msgs: number, convs: number) => graph("me/conversations", tok, { platform: "instagram", fields: "id,updated_time,participants,messages.limit(" + msgs + "){id,from,to,message,created_time,attachments,reactions,shares,story}", limit: String(convs) });
    let j: Row;
    try { j = await pedir(completo ? 30 : 10, completo ? 50 : 25); }
    catch (e) { if (!/reduce the amount/i.test(String(e))) throw e; try { j = await pedir(10, 15); } catch (e2) { if (!/reduce the amount/i.test(String(e2))) throw e2; j = await pedir(5, 8); } }
    for (const c of j.data || []) {
      const outro = (c.participants?.data || []).find((p: Row) => String(p.id) !== id) as Row | undefined;
      if (!outro) continue;
      const conversa_id = `ig:${id}:${outro.id}`;
      const msgs = (c.messages?.data || []) as Row[];
      // Lida = a conversa foi aberta no app (lida_em) ou eu respondi depois. O número não volta sozinho a cada sync.
      const { data: ex } = await db.from("ig_conversas").select("nao_lidas,lead_id,participante_username,lida_em").eq("id", conversa_id).maybeSingle();
      const idxMinha = msgs.findIndex((m) => String((m.from as Row)?.id) === id);
      const corte = Math.max(ex?.lida_em ? new Date(String(ex.lida_em)).getTime() : 0, idxMinha !== -1 ? new Date(String(msgs[idxMinha].created_time)).getTime() : 0);
      const vista = (m: Row) => new Date(String(m.created_time)).getTime() <= corte;
      const ultima = msgs[0];
      const naoLidas = msgs.filter((m) => String((m.from as Row)?.id) !== id && !vista(m)).length;
      await db.from("ig_conversas").upsert({
        id: conversa_id, conta_id: id, participante_id: String(outro.id), participante_username: (outro.username as string) || ex?.participante_username || String(outro.id),
        ultima_msg: (ultima?.message as string) || "", ultima_em: (ultima?.created_time as string) || c.updated_time, ultima_de_mim: ultima ? String((ultima.from as Row)?.id) === id : null,
        nao_lidas: naoLidas,
        lead_id: ex?.lead_id || null,
      });
      // as mensagens vêm depois da conversa: a chave estrangeira exige a conversa gravada (conta nova perdia todas as mensagens no 1º sync)
      for (const m of msgs) {
        const de_mim = String((m.from as Row)?.id) === id;
        const tipo = m.story ? "story_reply" : ((m.attachments as Row)?.data ? "anexo" : "texto");
        await db.from("ig_mensagens").upsert({ id: m.id, conversa_id, conta_id: id, de_mim, texto: (m.message as string) || (m.story ? "(respondeu ao story)" : "(anexo)"), tipo, anexos: (m.attachments as Row)?.data || [], criado_em: m.created_time, lido: de_mim || vista(m) }, { onConflict: "id", ignoreDuplicates: true });
      }
      n++;
    }
  } catch (e) { await log("erro", id, { onde: "conversas", erro: String(e).slice(0, 300) }); return String(e).slice(0, 120); }
  return n;
}

// ======================= AÇÕES NO INSTAGRAM =======================
async function responderComentario(id: string, texto: string, quem: string) {
  const { data: c } = await db.from("ig_comentarios").select("*").eq("id", id).single();
  const tok = await tokenDaConta(c.conta_id);
  if (!tok) throw new Error("conta sem token");
  let r: Row;
  try { r = await graphPost(`${id}/replies`, tok, { message: texto }); }
  catch (e) {
    // comentário apagado pelo autor (ou removido pelo Instagram): sai da fila em vez de ficar travado
    if (comentarioSumiu(e)) { await marcarApagado(id); throw new Error("Esse comentário foi apagado no Instagram. Tirei da fila."); }
    throw e;
  }
  await db.from("ig_comentarios").update({ respondido: true, resposta_texto: texto, lido: true }).eq("id", id);
  await db.from("ig_comentarios").upsert({ id: r.id, conta_id: c.conta_id, midia_id: c.midia_id, parent_id: id, autor_id: c.conta_id, texto, criado_em: new Date().toISOString(), de_mim: true, lido: true, respondido: true });
  await db.from("ig_acoes").update({ status: "feita", feita_em: new Date().toISOString(), feita_por: quem }).eq("comentario_id", id).eq("status", "pendente");
  // depois do público, vai ao direct (fluxo CP) se o autor passa na triagem
  if (c.lead_id) {
    await db.from("ig_acoes").insert({ conta_id: c.conta_id, lead_id: c.lead_id, comentario_id: id, data: hoje(), bloco: 2, tipo: "triagem", titulo: `Triagem de @${c.autor_username} (comentou no post)`, origem: "cp:apos_resposta", url: `https://www.instagram.com/${c.autor_username}/` });
  }
  return { ok: true, id: r.id };
}

const comentarioSumiu = (e: unknown) => /does not exist|code 100|subcode.?33/i.test(String(e));
async function marcarApagado(id: string) {
  await db.from("ig_comentarios").update({ oculto: true, lido: true, sugestao_ia: "apagado no Instagram" }).eq("id", id);
  await db.from("ig_acoes").update({ status: "pulada", feita_em: new Date().toISOString(), feita_por: "instagram" }).eq("comentario_id", id).eq("status", "pendente");
}
// Confere na API se os comentários pendentes ainda existem; os apagados saem da fila. {conta_id}
async function conferirComentarios(conta_id: string) {
  const tok = await tokenDaConta(conta_id);
  if (!tok) throw new Error("conta sem token");
  const { data: cs } = await db.from("ig_comentarios").select("id").eq("conta_id", conta_id).eq("de_mim", false).eq("respondido", false).eq("oculto", false).is("parent_id", null).limit(200);
  let apagados = 0;
  for (const c of cs || []) {
    try { await graph(c.id, tok, { fields: "id" }); }
    catch (e) { if (comentarioSumiu(e)) { await marcarApagado(c.id); apagados++; } }
  }
  await log("sync", conta_id, { conferir_comentarios: cs?.length || 0, apagados });
  return { conferidos: cs?.length || 0, apagados };
}
async function ocultarComentario(id: string, ocultar: boolean) {
  const { data: c } = await db.from("ig_comentarios").select("conta_id").eq("id", id).single();
  const tok = await tokenDaConta(c.conta_id);
  await graphPost(id, tok!, { hide: ocultar });
  await db.from("ig_comentarios").update({ oculto: ocultar, lido: true }).eq("id", id);
  return { ok: true };
}

async function enviarDM(conversa_id: string, texto: string, quem: string) {
  const { data: cv } = await db.from("ig_conversas").select("*").eq("id", conversa_id).single();
  const tok = await tokenDaConta(cv.conta_id);
  if (!tok) throw new Error("conta sem token");
  const r = await graphPost("me/messages", tok, { recipient: { id: cv.participante_id }, message: { text: texto } });
  const agora = new Date().toISOString();
  await db.from("ig_mensagens").upsert({ id: r.message_id || `local:${Date.now()}`, conversa_id, conta_id: cv.conta_id, de_mim: true, texto, tipo: "texto", criado_em: agora, lido: true });
  await db.from("ig_conversas").update({ ultima_msg: texto, ultima_em: agora, ultima_de_mim: true, nao_lidas: 0 }).eq("id", conversa_id);
  await db.from("ig_acoes").update({ status: "feita", feita_em: agora, feita_por: quem }).eq("conversa_id", conversa_id).eq("status", "pendente").in("tipo", ["responder_dm", "avancar", "ativar", "followup"]);
  if (cv.lead_id) {
    const { data: l } = await db.from("ig_leads").select("etapa,toques,fluxo").eq("id", cv.lead_id).single();
    const toques = (l?.toques || 0) + 1;
    const upd: Row = { ultimo_toque: agora, toques };
    if (l?.etapa === "novo" || l?.etapa === "icp" || l?.etapa === "aquecendo") { const prox = proximaMensagem(await fluxoDaConta(cv.conta_id, String(l?.fluxo || "NS")), toques); upd.etapa = "ativado"; upd.proximo_toque = prox ? somaDias(hoje(), prox.dia || 2) : null; }
    await db.from("ig_leads").update(upd).eq("id", cv.lead_id);
  }
  return { ok: true, id: r.message_id };
}

// ======================= LEAD: PESQUISA + IA =======================
const RX_CONCORRENTE = /(consultor(?:ia|a|es)?|mentor(?:ia|a|es)?|treinament|curso|palestr|workshop|imers[aã]o|m[eé]todo|franquia de|software|sistema de gest[aã]o|agência|agencia|contador(?:a)? (?:d[eo]s?|para) restaurant|contabilidade|marketing (?:para|de) restaurant|gest[aã]o (?:de|para) restaurant|lucro (?:de|para|no) restaurant|dono?s? de restaurante|restaurant(?:e|es)? lucrativ|ajudo (?:restaurant|donos|empres))/i;
function ehConcorrente(t: string): string | null {
  const m = String(t || "").match(RX_CONCORRENTE);
  if (!m) return null;
  // só vale se, além do gatilho, falar de restaurante/food/gastronomia (ou gatilho já é específico)
  const especifico = /restaurant|gastron|food|alimenta|bar|pizzar|churrasc|delivery|cozinha/i.test(t) || /dono?s? de restaurante|contador|gest[aã]o (?:de|para) restaurant|restaurant(?:e|es)? lucrativ/i.test(m[0]);
  return especifico ? m[0] : null;
}

// Extrai nome, contagens e bio do texto da página do perfil (formato do get_page_text do Instagram)
function parsePerfil(t: string): Row {
  const num = (s: string) => { const m = s.replace(/\./g, "").match(/([\d,]+)\s*(mil|mi)?/i); if (!m) return null; let n = parseFloat(m[1].replace(",", ".")); if (/mil/i.test(m[2] || "")) n *= 1000; if (/^mi$/i.test(m[2] || "")) n *= 1e6; return Math.round(n); };
  const out: Row = {};
  const posts = t.match(/([\d.,]+\s*(?:mil|mi)?)\s*posts?/i); if (posts) out.posts = num(posts[1]);
  const seg = t.match(/([\d.,]+\s*(?:mil|mi)?)\s*seguidores/i); if (seg) out.seguidores = num(seg[1]);
  const sgd = t.match(/([\d.,]+\s*(?:mil|mi)?)\s*seguindo/i); if (sgd) out.seguindo = num(sgd[1]);
  out.privado = /perfil (é|e) privado/i.test(t);
  const menc = [...t.matchAll(/(?:^|[\s(·])@([a-z0-9._]{2,30})/gi)].map((m) => m[1].toLowerCase()); if (menc.length) out.mencoes = [...new Set(menc)].slice(0, 6);
  out.verificado = /verificad[oa]/i.test(t.slice(0, 200));
  // formato "username · Nome · N posts · ..." (resumo) ou linhas (página crua)
  const linhas = t.split(/\n|·/).map((x) => x.trim()).filter(Boolean);
  if (linhas.length > 1 && !/\d/.test(linhas[1])) out.nome = linhas[1].slice(0, 80);
  const idx = linhas.findIndex((l) => /seguindo/i.test(l));
  const bio = linhas.slice(idx + 1).filter((l) => !/^(seguir|seguir de volta|enviar mensagem|seguindo|destaques|mais|este perfil é privado|siga esse usuário|sugestões para você|ver tudo|ainda não há nenhum post|seguido\(a\) por|bio:|sem bio|sem nome|perfil privado)/i.test(l) && !/^seguido\(a\) por/i.test(l)).slice(0, 6).join(" · ");
  if (bio) out.bio = bio.slice(0, 300);
  const seguidoPor = t.match(/Seguido\(a\) por ([^\n·]+)/i); if (seguidoPor) out.seguido_por = seguidoPor[1].trim().slice(0, 120);
  return out;
}

async function pesquisarLead(conta_id: string, username: string, quem: string, extra: Row) {
  username = username.replace(/^@/, "").trim().toLowerCase();
  if (!username) throw new Error("username vazio");
  if (await ehDaCasa(conta_id, username)) throw new Error("@" + username + " está na lista de perfis que nunca viram lead desta conta");
  const tok = await tokenDaConta(conta_id);
  if (!tok) throw new Error("conta sem token");
  let perfil: Row = {};
  if (extra.perfil_texto) {
    // texto da página do perfil (lido pelo navegador): bio, contagens, legendas recentes
    perfil = { fonte: "pagina", texto: String(extra.perfil_texto).slice(0, 5000), ...parsePerfil(String(extra.perfil_texto)) };
  } else {
    try {
      const j = await graph(conta_id, tok, { fields: `business_discovery.username(${username}){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(8){caption,like_count,comments_count,media_type,permalink,timestamp}}` });
      perfil = j.business_discovery || {};
    } catch (e) {
      perfil = { erro: String(e).includes("nonexisting field") ? "business_discovery indisponível no login do Instagram; sem dados do perfil" : String(e).includes("2207013") || String(e).toLowerCase().includes("not found") ? "perfil não é business/creator ou não existe" : String(e).slice(0, 200) };
    }
  }
  // Regra fixa: quem vende consultoria/mentoria/treinamento/curso para dono de restaurante é CONCORRENTE. Nunca entra no fluxo.
  const textoPerfil = [perfil.texto, perfil.biography, perfil.name, perfil.nome, perfil.bio, (perfil.media as Row)?.data ? JSON.stringify((perfil.media as Row).data).slice(0, 2000) : ""].filter(Boolean).join(" ");
  const concorrente = ehConcorrente(textoPerfil + " " + username);
  // IA: triagem + conexão + mensagem
  const fluxo = String(extra.fluxo || "NS");
  const fx = await fluxoDaConta(conta_id, fluxo);
  const passoMsg = fx.passos.find((p) => p.tipo === "mensagem");
  const prompt = `${PLAYBOOK_IA}

MODELO DA PRIMEIRA MENSAGEM DESTE FLUXO (${fx.nome}); use como base, trocando [Nome], [restaurante], [conexao] e [pergunta factual] por conteúdo real do perfil:
${passoMsg?.texto || "(modelo base de boas-vindas)"}

TAREFA: triagem de ICP (nível 1) e rascunho da mensagem de ativação para um perfil que chegou pelo fluxo ${fluxo}.
REGRA DURA: "passa" só com evidência NO PERFIL (bio, nome, posts) de que é dono/sócio de restaurante em operação. Comentário, curtida ou sinal de calor sozinhos NUNCA bastam: sem dados do perfil, responda "indefinido".
Dados do perfil (business_discovery do Instagram; se vier erro, use só o username e diga que precisa de pesquisa manual):
${JSON.stringify(perfil).slice(0, 6000)}
${extra.sinal ? `Sinal de calor informado: ${extra.sinal}` : ""}
Hora atual: ${saudacao()}.

ATENÇÃO, CONCORRENTE: se o perfil vende consultoria, mentoria, treinamento, curso, palestra, método, software de gestão, contabilidade ou agência de marketing PARA restaurantes/donos de restaurante (ex.: "ajudo donos de restaurante a lucrar", "mentor de donos de restaurante", "consultoria para restaurantes", "o contador dos restaurantes"), marque "concorrente": true e "icp": "nao_passa". Ele segue para aprender, não para comprar.
Responda SÓ JSON com:
{"icp":"passa|nao_passa|indefinido","concorrente":false,"motivo":"1 linha","nome":"primeiro nome provável ou vazio","restaurante":"nome ou vazio","restaurante_ig":"@ do Instagram do restaurante sem o @ (se o próprio perfil for o restaurante, repita o username; se a bio marcar o restaurante, use o @ marcado; senão vazio)","cidade":"ou vazio","segmento":"self-service|a quilo|churrascaria|marmitaria|pizzaria|delivery|bar|outro|desconhecido","porte":"pequeno|medio|rede","sinais":["..."],"modelo":1-12,"conexao":"o detalhe específico, verdadeiro, tirado do perfil (sem elogio genérico)","pergunta_factual":"uma pergunta de zero esforço","mensagem":"a mensagem completa do passo (3 a 4 linhas, pronta para colar, SEM lacunas entre colchetes, SEM citar Programa de Aceleração ou qualquer oferta: é só conexão + uma pergunta; se o restaurante for desconhecido, pergunte o que ele toca)","pesquisa_profunda":true|false (true SÓ para rede, franquia, multi-unidade ou operação claramente grande; para perfil pessoal, pequeno ou sem dados use false)}`;
  // sem dados do perfil (nem página lida, nem business_discovery) ninguém passa no ICP: comentário sozinho não prova que é dono
  const semPerfil = !String(perfil.texto || perfil.biography || perfil.name || "").trim();
  let ia: Row = {};
  if (concorrente) ia = { icp: "nao_passa", motivo: "CONCORRENTE: o perfil vende consultoria, mentoria, treinamento ou serviço para donos de restaurante (" + concorrente + "). Não abordar.", concorrente: true, modelo: null };
  else try { ia = parseJSON(await gemini(prompt, { json: true, temp: 0.6 })); if (ia.concorrente === true) { ia.icp = "nao_passa"; ia.motivo = "CONCORRENTE (IA): " + (ia.motivo || ""); } } catch (e) { ia = { erro: String(e).slice(0, 200) }; }
  if (semPerfil && !ia.concorrente && ia.icp === "passa") { ia.icp = "indefinido"; ia.motivo = "Sem perfil lido, precisa confirmar: " + (ia.motivo || ""); }
  const { data: ex } = await db.from("ig_leads").select("id,etapa").eq("conta_id", conta_id).eq("username", username).maybeSingle();
  const row: Row = {
    conta_id, username, fluxo, perfil, icp: (ia.icp as string) || "indefinido",
    nome: (ia.nome as string) || (perfil.name as string) || null, restaurante: (ia.restaurante as string) || null, restaurante_ig: String(ia.restaurante_ig || "").replace(/^@/, "").trim().toLowerCase() || null, cidade: (ia.cidade as string) || null, segmento: (ia.segmento as string) || null,
    conexao: (ia.conexao as string) || null, sinal_calor: ia.concorrente ? "CONCORRENTE" : ((extra.sinal as string) || ((ia.sinais as string[]) || []).join(", ") || null),
    pesquisa: ia.motivo ? `IA: ${ia.motivo}${ia.pesquisa_profunda ? " · Pesquisa profunda recomendada (conta grande)." : ""}` : null,
    criado_por: quem,
  };
  // etapa: desqualificado | ICP (modo manual: a pessoa faz o D1 e move para Aquecendo) | aquecendo (automático) | novo (indefinido)
  const { data: contaRow } = await db.from("ig_contas").select("config").eq("id", conta_id).maybeSingle();
  const manual = ((contaRow?.config || {}) as Row).modo === "aprovacao";
  const entraNoFluxo = !manual && ia.icp !== "nao_passa"; // manual: ICP espera a pessoa fazer o D1 e mover para Aquecendo
  const etapaNova = ia.icp === "nao_passa" ? "fora_icp" : ia.icp === "passa" ? (manual ? "icp" : "aquecendo") : (manual ? "novo" : "aquecendo");
  // não rebaixa quem já avançou no pipeline (re-triagem de lead em conversa)
  if (!ex || ["novo", "icp", "aquecendo", "fora_icp"].includes(String((ex as Row).etapa || "novo"))) row.etapa = etapaNova;
  let lead_id = ex?.id;
  if (ex) { await db.from("ig_leads").update(row).eq("id", ex.id); } else { const { data } = await db.from("ig_leads").insert(row).select("id").single(); lead_id = data?.id; }
  // ações: vêm do fluxo configurado da conta (ou do padrão do playbook)
  if (ia.icp !== "nao_passa") {
    await db.from("ig_acoes").update({ status: "feita", feita_em: new Date().toISOString(), feita_por: quem }).eq("lead_id", lead_id).eq("tipo", "triagem").eq("status", "pendente");
    if (entraNoFluxo) await entrarNoFluxo(String(lead_id), quem, ia.mensagem as string | undefined);
  } else {
    await db.from("ig_acoes").update({ status: "pulada", feita_em: new Date().toISOString(), feita_por: quem }).eq("lead_id", lead_id).eq("status", "pendente");
  }
  return { lead_id, perfil, ia };
}

// conta com voz própria (config.voz): devolve {username, voz}; sem voz, null (vale o playbook de vendas)
async function vozDaConta(conta_id: string): Promise<{ username: string; voz: string } | null> {
  if (!conta_id) return null;
  const { data } = await db.from("ig_contas").select("username,nome,biografia,config").eq("id", conta_id).maybeSingle();
  const cfg = (data?.config || {}) as Row;
  const voz = String(cfg.voz || "").trim();
  if (voz) return { username: String(data?.username || ""), voz };
  // sem voz escrita: só as contas marcadas com o playbook da casa (config.playbook = "lidera") usam o método de vendas da Lidera
  if (cfg.playbook === "lidera") return null;
  return { username: String(data?.username || ""), voz: vozNeutra(data as Row) };
}
// conta nova, sem voz configurada: a IA se apoia no nome e na bio, sem assumir nicho nenhum
const vozNeutra = (c: Row | null) => `Perfil @${c?.username || ""}${c?.nome ? " (" + c.nome + ")" : ""}. Bio: ${String(c?.biografia || "sem bio").slice(0, 400)}. Fale em primeira pessoa, de forma natural e direta, no tom dos posts da própria conta, sem inventar fatos sobre o negócio.`;

// leads e conversas gravados com o número do Instagram no lugar do @ (a consulta do perfil falhou na hora): tenta de novo
async function resolverNomes(id: string, tok: string) {
  let n = 0;
  const { data: cvs } = await db.from("ig_conversas").select("id,participante_id,participante_username").eq("conta_id", id).filter("participante_username", "match", "^[0-9]{9,}$").limit(15);
  const { data: lds } = await db.from("ig_leads").select("id,username,ig_user_id").eq("conta_id", id).filter("username", "match", "^[0-9]{9,}$").limit(15);
  const igsids = [...new Set([...(cvs || []).map((c) => String(c.participante_id || c.participante_username)), ...(lds || []).map((l) => String(l.ig_user_id || l.username))])];
  for (const igsid of igsids) {
    let p: Row;
    try { p = await graph(igsid, tok, { fields: "username,name" }); } catch { continue; }
    const u = String(p.username || "").toLowerCase();
    if (!u) continue;
    await db.from("ig_conversas").update({ participante_username: u, ...(p.name ? { participante_nome: p.name } : {}) }).eq("conta_id", id).eq("participante_id", igsid);
    for (const l of (lds || []).filter((x) => String(x.ig_user_id || x.username) === igsid)) {
      const { data: outro } = await db.from("ig_leads").select("id").eq("conta_id", id).eq("username", u).maybeSingle();
      if (outro) await db.from("ig_leads").update({ etapa: "encerrado", pesquisa: `Duplicado de @${u}: o Instagram tinha entregue só o número.` }).eq("id", l.id);
      else await db.from("ig_leads").update({ username: u, ...(p.name ? { nome: p.name } : {}) }).eq("id", l.id);
    }
    n++;
  }
  return n;
}

async function sugerir(tipo: string, id: string) {
  if (tipo === "comentario") {
    const { data: c0 } = await db.from("ig_comentarios").select("*").eq("id", id).single();
    const { data: md } = c0?.midia_id ? await db.from("ig_midias").select("legenda").eq("id", c0.midia_id).maybeSingle() : { data: null };
    const c = { ...c0, ig_midias: md };
    const vz = await vozDaConta(String(c0?.conta_id || ""));
    if (vz) {
      const pr = `Você responde comentários no Instagram @${vz.username}, em primeira pessoa. Quem é e como fala:\n${vz.voz}\n
TAREFA: responder em público o comentário abaixo, como o dono do perfil responderia: 1 a 2 linhas, natural, no tom do comentário (brincadeira com brincadeira, dúvida com resposta direta, crítica com educação e sem bater boca), sem vender nada, sem "obrigado pelo comentário", no máximo 1 emoji, nunca travessão.
Legenda do post: ${(c.ig_midias?.legenda || "").slice(0, 800)}
Comentário de @${c.autor_username}: ${c.texto}
Responda SÓ JSON: {"resposta_publica":"...","abridor_direct":"","ehLead":false,"motivo":"1 linha sobre o tom escolhido"}`;
      const ia = parseJSON(await gemini(pr, { json: true }));
      await db.from("ig_comentarios").update({ sugestao_ia: ia.resposta_publica }).eq("id", id);
      return ia;
    }
    const prompt = `${PLAYBOOK_IA}
TAREFA: um seguidor comentou num post do Charles. Escreva a resposta PÚBLICA (1 a 2 linhas, agrega valor, sem "top!", sem "obrigado" seco, pode terminar com uma pergunta curta) e um abridor de DIRECT (2 a 3 linhas, referência ao comentário dele, uma pergunta factual).
Legenda do post: ${(c.ig_midias?.legenda || "").slice(0, 800)}
Comentário de @${c.autor_username}: ${c.texto}
Responda SÓ JSON: {"resposta_publica":"...","abridor_direct":"...","ehLead":true|false,"motivo":"1 linha"}`;
    const ia = parseJSON(await gemini(prompt, { json: true }));
    await db.from("ig_comentarios").update({ sugestao_ia: ia.resposta_publica }).eq("id", id);
    return ia;
  }
  // dm
  const { data: cv } = await db.from("ig_conversas").select("*, ig_leads(*)").eq("id", id).single();
  const { data: msgs } = await db.from("ig_mensagens").select("de_mim,texto,tipo,criado_em").eq("conversa_id", id).order("criado_em", { ascending: false }).limit(30);
  const hist = (msgs || []).reverse().map((m) => `${m.de_mim ? "CHARLES" : "LEAD"}: ${m.texto}`).join("\n");
  const l = cv.ig_leads || {};
  const vzD = await vozDaConta(String(cv.conta_id || ""));
  if (vzD) {
    const pr = `Você responde o direct do Instagram @${vzD.username}, em primeira pessoa. Quem é e como fala:\n${vzD.voz}\n
TAREFA: escrever a próxima mensagem desta conversa, como o dono do perfil escreveria: curta (1 a 3 linhas), natural, sem roteiro de vendas, sem forçar pergunta no final. Se a pessoa pediu algo objetivo, responda o que foi pedido.
Hora atual: ${saudacao()}.
Conversa com @${cv.participante_username} (EU = dono do perfil):
${hist.replace(/^CHARLES:/gm, "EU:").replace(/^LEAD:/gm, "ELE:")}
Responda SÓ JSON: {"camada":0,"degrau":0,"mensagem":"...","etapa_sugerida":"","desafio":"","observacao":"1 linha"}`;
    return parseJSON(await gemini(pr, { json: true }));
  }
  const prompt = `${PLAYBOOK_IA}
TAREFA: continuar esta conversa de direct seguindo as camadas. Identifique em que camada/degrau a conversa está e escreva a PRÓXIMA mensagem do Charles (3 a 4 linhas, uma pergunta no final, saudação temporal só se for a primeira do dia). Se o lead fez objeção, use a quebra correspondente. Se o lead já respondeu o degrau 4, vá para a faixa de faturamento; se já deu a faixa, faça o convite com prova social; se aceitou, ofereça dois horários.
Hora atual: ${saudacao()}.
Lead: @${cv.participante_username} · nome: ${l.nome || "?"} · restaurante: ${l.restaurante || "?"} · cidade: ${l.cidade || "?"} · fluxo: ${l.fluxo || "?"} · etapa atual: ${ETAPAS[l.etapa] || l.etapa || "?"} · faixa: ${l.faixa || "?"} · desafio registrado: ${l.desafio || "-"} · ganho (degrau 4): ${l.ganho || "-"}
Histórico (mais antigo primeiro):
${hist || "(sem mensagens ainda)"}

Responda SÓ JSON: {"camada":0-4,"degrau":0-4,"mensagem":"...","etapa_sugerida":"novo|aquecendo|ativado|rmv|desafio|escada|convite|agendado_charles|agendado_guilherme|frio|fora_icp","desafio":"frase LITERAL do lead sobre o desafio, se apareceu, senão vazio","ganho":"frase LITERAL do degrau 4, se apareceu, senão vazio","faixa":"ate100|100a300|300a500|acima500|","objecao":"nome da objeção se houver, senão vazio","observacao":"1 linha para o SDR"}`;
  const ia = parseJSON(await gemini(prompt, { json: true, temp: 0.7 }));
  // atualiza o lead com o que a IA extraiu (sem sobrescrever o que já tem)
  if (cv.lead_id) {
    const upd: Row = {};
    if (ia.desafio && !l.desafio) upd.desafio = ia.desafio;
    if (ia.ganho && !l.ganho) upd.ganho = ia.ganho;
    if (ia.faixa && !l.faixa) upd.faixa = ia.faixa;
    if (Object.keys(upd).length) await db.from("ig_leads").update(upd).eq("id", cv.lead_id);
    await db.from("ig_conversas").update({ camada: ia.camada }).eq("id", id);
  }
  return ia;
}

async function classificarMidias(conta_id: string) {
  const { data: ms } = await db.from("ig_midias").select("id,legenda").eq("conta_id", conta_id).is("categoria", null).order("publicado_em", { ascending: false }).limit(40);
  if (!ms?.length) return { n: 0 };
  const prompt = `Classifique cada post do Instagram de um consultor de restaurantes no motor de conteúdo "3 por 2": dor (dor nomeada do dono), bastidor (caso real sem nome), ensino (prática: CMV, folha, precificação), convite (convite ao diagnóstico), resultado (resultado de cliente com número), outro.
Posts: ${JSON.stringify(ms.map((m) => ({ id: m.id, legenda: (m.legenda || "").slice(0, 300) })))}
Responda SÓ JSON: {"<id>":"categoria", ...}`;
  const ia = parseJSON(await gemini(prompt, { json: true, temp: 0.2 }));
  let n = 0;
  for (const [id, cat] of Object.entries(ia)) { await db.from("ig_midias").update({ categoria: String(cat) }).eq("id", id); n++; }
  return { n };
}

// ======================= CRIAÇÃO DE CONTEÚDO (IA) =======================
// body: { conta_id, modo: 'ideias'|'post'|'carrossel'|'reel'|'story'|'reescrever', tema?, categoria?, texto?, tom? }
async function criarConteudo(body: Row) {
  const conta_id = String(body.conta_id || "");
  const { data: conta } = await db.from("ig_contas").select("username,nome,biografia,config").eq("id", conta_id).maybeSingle();
  const cfgC = (conta?.config || {}) as Row;
  const vozPropria = String(cfgC.voz || "").trim() || (cfgC.playbook === "lidera" ? "" : vozNeutra(conta as Row));
  const { data: tops } = await db.from("ig_midias").select("legenda,interacoes,alcance,categoria").eq("conta_id", conta_id).order("interacoes", { ascending: false, nullsFirst: false }).limit(5);
  const baseCharles = `Você escreve para o Instagram do Charles (@${conta?.username || "charles.simon"}), consultor de restaurantes do Programa Lucro e Liberdade (gestão financeira e gestão de pessoas para donos de restaurante, self-service, a quilo, churrascaria, marmitaria, pizzaria, delivery). Público: donos de restaurante que faturam de 100 a 500 mil por mês, cansados, que faturam bem e sobra pouco.
Tom: direto, de quem está na operação, português do Brasil falado, frases curtas, zero jargão de marketing, zero "você sabia que", no máximo 1 emoji por texto, nunca travessão. Dados reais do nicho quando possível (CMV saudável 30%, folha 25%, lucro mínimo 15%).
Motor de conteúdo 3 por 2 (ciclo de 5 publicações): dor (dor nomeada: "Restaurante que fatura 300 mil e o dono tira 4 mil"), bastidor (caso real sem nome), ensino (como calcular CMV, o que olhar na folha, o erro de precificação do quilo), convite (Diagnóstico Individual Estratégico: 40 min por vídeo, sem custo, sai sabendo quanto vira lucro e os 3 maiores vazamentos), resultado (resultado de cliente com número).
Posts que mais engajaram desta conta (para referência de estilo): ${JSON.stringify((tops || []).map((t) => ({ legenda: (t.legenda || "").slice(0, 200), interacoes: t.interacoes, categoria: t.categoria })))}
`;
  // conta com voz própria (config.voz) não usa o playbook do Charles
  const base = vozPropria ? `Você escreve para o Instagram @${conta?.username}. Quem é e como fala:\n${vozPropria}\nRegras de escrita: português do Brasil falado, frases curtas, zero jargão de marketing, zero "você sabia que", no máximo 1 emoji por texto, nunca travessão.\nPosts que mais engajaram desta conta: ${JSON.stringify((tops || []).map((t) => ({ legenda: (t.legenda || "").slice(0, 200), interacoes: t.interacoes })))}\n` : baseCharles;
  const modo = String(body.modo || "ideias");
  const tema = String(body.tema || "");
  const cat = String(body.categoria || "");
  let tarefa = "";
  if (modo === "ideias") tarefa = `Gere 6 ideias de conteúdo${cat ? ` da categoria "${cat}"` : " cobrindo o ciclo 3 por 2 (dor, bastidor, ensino, convite, resultado, mais 1 dor)"}${tema ? ` sobre: ${tema}` : ""}. Responda SÓ JSON: {"ideias":[{"categoria":"dor|bastidor|ensino|convite|resultado","formato":"post|carrossel|reel|story","titulo":"...","gancho":"primeira frase que para o dedo (até 12 palavras)","resumo":"2 linhas do que o conteúdo entrega"}]}`;
  else if (modo === "post") tarefa = `Escreva um post (imagem única) ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Responda SÓ JSON: {"titulo":"...","gancho":"texto da imagem, até 10 palavras","legenda":"legenda completa de 6 a 10 linhas, com quebras de linha, terminando com uma pergunta ou CTA","cta":"...","hashtags":"8 a 12 hashtags do nicho, separadas por espaço"}`;
  else if (modo === "carrossel") tarefa = `Escreva um carrossel de 7 a 9 slides ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Responda SÓ JSON: {"titulo":"...","gancho":"capa, até 10 palavras","roteiro":"Slide 1: ...\\nSlide 2: ...\\n(cada slide com título curto e 1 a 2 frases)","legenda":"legenda de 4 a 6 linhas","cta":"último slide","hashtags":"..."}`;
  else if (modo === "reel") tarefa = `Escreva o roteiro de um reel de 30 a 45 segundos ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Responda SÓ JSON: {"titulo":"...","gancho":"os 3 primeiros segundos, falado","roteiro":"[0-3s] ...\\n[3-15s] ...\\n[15-35s] ...\\n[35-45s] CTA","legenda":"legenda de 3 a 5 linhas","cta":"...","hashtags":"..."}`;
  else if (modo === "story") tarefa = `Crie uma sequência de 3 a 4 stories ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Um deles deve ser de captura (enquete, quiz ou caixinha) com a pergunta pronta. Responda SÓ JSON: {"titulo":"...","roteiro":"Story 1 (texto na tela + o que falar)...\\nStory 2...\\nStory 3 (CAPTURA: enquete/quiz/caixinha com as opções)...","legenda":"","cta":"...","hashtags":""}`;
  else if (modo === "reescrever") tarefa = `Reescreva o texto abaixo no tom descrito, mantendo o sentido, mais curto e mais forte. Texto:\n${String(body.texto || "")}\nResponda SÓ JSON: {"legenda":"texto reescrito"}`;
  if (vozPropria) {
    const pilares = (((conta?.config || {}) as Row).pilares as string[]) || [];
    const lista = pilares.length ? pilares.join(", ") : "os assuntos do perfil";
    tarefa = tarefa.replace(' cobrindo o ciclo 3 por 2 (dor, bastidor, ensino, convite, resultado, mais 1 dor)', ` cobrindo os pilares do perfil (${lista})`)
      .replace('"categoria":"dor|bastidor|ensino|convite|resultado"', `"categoria":"${pilares.length ? pilares.join("|") : "pilar do perfil"}"`)
      .replace("Um deles deve ser de captura (enquete, quiz ou caixinha) com a pergunta pronta.", "Um deles deve pedir interação (enquete, quiz ou caixinha) com a pergunta pronta.")
      .replace("hashtags do nicho", "hashtags do assunto");
  }
  const out = parseJSON(await gemini(base + "\n" + tarefa + (body.tom ? `\nAjuste de tom pedido: ${body.tom}` : ""), { json: true, temp: 0.8, esforco: "medium" }));
  return out;
}

// ======================= PUBLICAR NO INSTAGRAM =======================
// Espera o Instagram terminar de processar um contêiner de mídia (imagem ou carrossel) antes do media_publish.
async function esperarPronto(creation: string, tok: string, voltas: number) {
  for (let i = 0; i < voltas; i++) {
    const st = await graph(creation, tok, { fields: "status_code,status" });
    if (st.status_code === "FINISHED") return;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error("Instagram não processou a mídia: " + String(st.status || st.status_code).slice(0, 200));
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("O Instagram ainda está processando a mídia. Tente publicar de novo em um minuto.");
}

// body: { conta_id, planejado_id?, tipo: 'post'|'reel'|'carrossel', midia_url | midia_urls[], legenda }
async function publicar(body: Row, quem: string) {
  const conta_id = String(body.conta_id || "");
  const tok = await tokenDaConta(conta_id);
  if (!tok) throw new Error("conta sem token");
  const legenda = String(body.legenda || "");
  const tipo = String(body.tipo || "post");
  let creation: string;
  if (tipo === "carrossel") {
    const urls = (body.midia_urls as string[]) || [];
    if (urls.length < 2) throw new Error("carrossel precisa de 2 a 10 imagens");
    const filhos: string[] = [];
    for (const u of urls) { const c = await graphPost(`${conta_id}/media`, tok, { image_url: u, is_carousel_item: true }); filhos.push(c.id); }
    creation = (await graphPost(`${conta_id}/media`, tok, { media_type: "CAROUSEL", children: filhos.join(","), caption: legenda })).id;
    await esperarPronto(creation, tok, 12);
  } else if (tipo === "reel") {
    creation = (await graphPost(`${conta_id}/media`, tok, { media_type: "REELS", video_url: String(body.midia_url), caption: legenda, share_to_feed: true })).id;
    // vídeo processa em segundo plano: espera até ficar FINISHED (máx ~90 s)
    for (let i = 0; i < 18; i++) {
      const st = await graph(creation, tok, { fields: "status_code,status" });
      if (st.status_code === "FINISHED") break;
      if (st.status_code === "ERROR") throw new Error("Instagram não processou o vídeo: " + JSON.stringify(st.status));
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    creation = (await graphPost(`${conta_id}/media`, tok, { image_url: String(body.midia_url), caption: legenda })).id;
    await esperarPronto(creation, tok, 12);
  }
  const pub = await graphPost(`${conta_id}/media_publish`, tok, { creation_id: creation });
  if (body.planejado_id) await db.from("ig_planejados").update({ status: "publicado", ig_media_id: pub.id, publicado_em: new Date().toISOString() }).eq("id", String(body.planejado_id));
  if (body.planejado_id) await db.from("ig_automacoes").update({ midia_id: pub.id }).eq("planejado_id", String(body.planejado_id));
  await log("acao", conta_id, { tipo: "publicar", por: quem, media_id: pub.id, formato: tipo });
  // puxa a mídia nova para a biblioteca
  try { await syncMidias(conta_id, tok, false); } catch { /* o cron pega depois */ }
  return { ok: true, media_id: pub.id };
}

// ======================= AGENDA =======================
// Publica no Instagram o que está 'agendado' e já chegou na hora (America/Sao_Paulo). Cron a cada 5 min.
// Imagem: publica no mesmo ciclo. Reel: cria o container, guarda creation_id e publica quando o Instagram terminar de processar.
// Trava contra envio duplo: a linha vira 'publicando' enquanto o ciclo trabalha nela. {dry?: true} só lista.
async function executarAgenda(body: Row) {
  const dry = !!body.dry;
  const agora = new Date();
  const out = { conferidos: 0, publicados: 0, processando: 0, erros: 0, itens: [] as Row[] };
  // destrava o que ficou 'publicando' por queda do ciclo anterior
  if (!dry) await db.from("ig_planejados").update({ status: "agendado" }).eq("status", "publicando").lt("atualizado_em", new Date(agora.getTime() - 10 * 60000).toISOString());
  const { data: pend } = await db.from("ig_planejados").select("*").eq("status", "agendado").lte("data", hoje()).contains("canais", ["instagram"]).is("ig_media_id", null).order("data").order("hora").limit(8);
  for (const p of pend || []) {
    const quando = new Date(`${p.data}T${String(p.hora || "12:00:00").slice(0, 8)}-03:00`);
    if (quando.getTime() > agora.getTime()) continue;
    out.conferidos++;
    const falha = async (erro: string) => { out.erros++; out.itens.push({ id: p.id, titulo: p.titulo, erro }); if (!dry) { await db.from("ig_planejados").update({ status: "erro", erro, atualizado_em: new Date().toISOString() }).eq("id", p.id); await log("erro", p.conta_id, { onde: "agenda", planejado: p.id, erro }); } };
    const atrasoH = (agora.getTime() - quando.getTime()) / 36e5;
    const urlsCar = ((p.midia_urls as string[]) || []).filter(Boolean);
    if (p.tipo === "story") { await falha("Story não pode ser publicado pela API do Instagram. Publique pelo app."); continue; }
    if (p.tipo === "carrossel" && (urlsCar.length < 2 || urlsCar.length > 10)) { await falha("Carrossel precisa de 2 a 10 imagens. Envie as lâminas e agende de novo."); continue; }
    if (p.tipo !== "carrossel" && !p.midia_url) { await falha("Sem mídia: envie o vídeo ou a imagem e agende de novo."); continue; }
    if (!p.creation_id && atrasoH > 12) { await falha("Passou mais de 12 h do horário agendado sem publicar. Confira e agende de novo."); continue; }
    if (dry) { out.itens.push({ id: p.id, titulo: p.titulo, quando: quando.toISOString(), acao: p.creation_id ? "conferir processamento" : "publicar" }); continue; }
    // trava
    const { data: travou } = await db.from("ig_planejados").update({ status: "publicando", atualizado_em: new Date().toISOString() }).eq("id", p.id).eq("status", "agendado").select("id");
    if (!travou?.length) continue;
    try {
      const tok = await tokenDaConta(p.conta_id);
      if (!tok) throw new Error("conta sem token: reconecte o Instagram em Contas");
      const legenda = [p.legenda, p.hashtags].filter(Boolean).join("\n\n").trim();
      const ehVideo = p.tipo !== "carrossel" && (p.tipo === "reel" || /\.(mp4|mov|m4v)(\?|$)/i.test(String(p.midia_url)));
      let creation = p.creation_id as string | null;
      let pronto = false;
      if (!creation) {
        if (p.tipo === "carrossel") {
          const filhos: string[] = [];
          for (const u of urlsCar) filhos.push((await graphPost(`${p.conta_id}/media`, tok, { image_url: u, is_carousel_item: true })).id);
          creation = (await graphPost(`${p.conta_id}/media`, tok, { media_type: "CAROUSEL", children: filhos.join(","), caption: legenda })).id;
        }
        else if (ehVideo) creation = (await graphPost(`${p.conta_id}/media`, tok, { media_type: "REELS", video_url: p.midia_url, caption: legenda, share_to_feed: true })).id;
        else creation = (await graphPost(`${p.conta_id}/media`, tok, { image_url: p.midia_url, caption: legenda })).id;
        await db.from("ig_planejados").update({ creation_id: creation, tentativas: 0, erro: null }).eq("id", p.id);
      }
      if (!pronto) {
        // vídeo, carrossel ou imagem: espera até ~40 s neste ciclo o Instagram processar; se não ficar pronto, o próximo ciclo continua
        // (publicar antes do FINISHED devolve "Media ID is not available", code 9007: aconteceu no 1º carrossel agendado, em 19/11/2026)
        for (let i = 0; i < 8 && !pronto; i++) {
          const st = await graph(creation!, tok, { fields: "status_code,status" });
          if (st.status_code === "FINISHED") { pronto = true; break; }
          if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error("Instagram não processou a mídia: " + String(st.status || st.status_code).slice(0, 200));
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      if (!pronto) {
        const t = Number(p.tentativas || 0) + 1;
        if (t > 24) throw new Error("O Instagram não terminou de processar a mídia em 2 h.");
        await db.from("ig_planejados").update({ status: "agendado", tentativas: t, atualizado_em: new Date().toISOString() }).eq("id", p.id);
        out.processando++; out.itens.push({ id: p.id, titulo: p.titulo, acao: "processando no Instagram" });
        continue;
      }
      const pub = await graphPost(`${p.conta_id}/media_publish`, tok, { creation_id: creation });
      let permalink: string | null = null;
      try { permalink = (await graph(pub.id, tok, { fields: "permalink" })).permalink || null; } catch { /* sync pega depois */ }
      await db.from("ig_planejados").update({ status: "publicado", ig_media_id: pub.id, permalink, publicado_em: new Date().toISOString(), erro: null, atualizado_em: new Date().toISOString() }).eq("id", p.id);
      await db.from("ig_automacoes").update({ midia_id: pub.id }).eq("planejado_id", p.id);
      await log("acao", p.conta_id, { tipo: "publicar", por: "agenda", media_id: pub.id, planejado: p.id });
      out.publicados++; out.itens.push({ id: p.id, titulo: p.titulo, acao: "publicado", permalink });
      try { await syncMidias(p.conta_id, tok, false); } catch { /* o cron pega depois */ }
    } catch (e) {
      const erro = String(e instanceof Error ? e.message : e).slice(0, 300);
      const t = Number(p.tentativas || 0) + 1;
      if (/9007|not available|not ready/i.test(erro) && t <= 24) {
        await db.from("ig_planejados").update({ status: "agendado", tentativas: t, atualizado_em: new Date().toISOString() }).eq("id", p.id);
        out.processando++; out.itens.push({ id: p.id, titulo: p.titulo, acao: "Instagram ainda processando, tenta no próximo ciclo" });
        continue;
      }
      out.erros++;
      out.itens.push({ id: p.id, titulo: p.titulo, erro });
      await db.from("ig_planejados").update({ status: "erro", erro, atualizado_em: new Date().toISOString() }).eq("id", p.id);
      await log("erro", p.conta_id, { onde: "agenda", planejado: p.id, erro });
    }
  }
  // TikTok: mesma agenda, canal próprio
  try { (out as Row).tiktok = await executarTikTok({ dry }); } catch (e) { (out as Row).tiktok = { erro: String(e).slice(0, 200) }; }
  return out;
}

// ======================= TIKTOK =======================
// Envia para o TikTok (API oficial) os vídeos marcados com canal "tiktok" que já venceram, nas contas com TikTok conectado.
// Modo da conta (config.tiktok_modo): "rascunho" (padrão) manda para a caixa de entrada do TikTok, a pessoa finaliza no app;
// "direto" publica (app sem auditoria só consegue privado). Depois acompanha o processamento até concluir.
async function executarTikTok(body: Row) {
  const dry = !!body.dry; const agora = new Date();
  const out = { enviados: 0, concluidos: 0, erros: 0, itens: [] as Row[] };
  const cfgs: Record<string, Row> = {};
  const cfgDe = async (cid: string) => { if (!cfgs[cid]) { const { data } = await db.from("ig_contas").select("config").eq("id", cid).maybeSingle(); cfgs[cid] = (data?.config || {}) as Row; } return cfgs[cid]; };
  // 1) acompanha o que já foi enviado
  const { data: andando } = await db.from("ig_planejados").select("id,conta_id,titulo,tiktok_publish_id").eq("tiktok_status", "enviando").not("tiktok_publish_id", "is", null).limit(10);
  for (const p of dry ? [] : andando || []) {
    try {
      const tok = await tkToken(p.conta_id); if (!tok) continue;
      const st = await tkStatus(tok, String(p.tiktok_publish_id));
      const status = String(st.status || "");
      if (status === "SEND_TO_USER_INBOX") { await db.from("ig_planejados").update({ tiktok_status: "na_caixa", tiktok_erro: null }).eq("id", p.id); out.concluidos++; }
      else if (status === "PUBLISH_COMPLETE") {
        const ids = (st.publicaly_available_post_id as unknown[]) || []; const cfg = await cfgDe(p.conta_id);
        await db.from("ig_planejados").update({ tiktok_status: "publicado", tiktok_erro: null, ...(ids[0] && cfg.tiktok ? { tiktok_url: `https://www.tiktok.com/@${cfg.tiktok}/video/${ids[0]}` } : {}) }).eq("id", p.id); out.concluidos++;
      } else if (status === "FAILED") { await db.from("ig_planejados").update({ tiktok_status: "erro", tiktok_erro: `TikTok recusou: ${st.fail_reason || "sem motivo"}` }).eq("id", p.id); out.erros++; }
    } catch (e) { await log("erro", p.conta_id, { onde: "tiktok status", planejado: p.id, erro: String(e).slice(0, 200) }); }
  }
  // 2) envia o que venceu
  const { data: pend } = await db.from("ig_planejados").select("*").eq("tiktok_status", "pendente").contains("canais", ["tiktok"]).in("status", ["agendado", "publicando", "publicado", "pronto"]).lte("data", hoje()).not("midia_url", "is", null).order("data").order("hora").limit(6);
  for (const p of pend || []) {
    const quando = new Date(`${p.data}T${String(p.hora || "12:00:00").slice(0, 8)}-03:00`);
    if (quando.getTime() > agora.getTime() || (agora.getTime() - quando.getTime()) / 36e5 > 12) continue;
    if (p.tipo === "carrossel" || p.tipo === "story" || p.tipo === "post") continue; // só vídeo
    const cfg = await cfgDe(p.conta_id);
    if (!cfg.tiktok_api) continue; // sem API conectada: fica na fila manual
    if (dry) { out.itens.push({ id: p.id, titulo: p.titulo, acao: `enviar ao TikTok (${opcoesTikTok(p, cfg).modo})` }); continue; }
    const { data: travou } = await db.from("ig_planejados").update({ tiktok_status: "enviando" }).eq("id", p.id).eq("tiktok_status", "pendente").select("id");
    if (!travou?.length) continue;
    try {
      const tok = await tkToken(p.conta_id);
      if (!tok) throw new Error("TikTok desconectado: conecte de novo em Contas");
      const r = await tkEnviarVideo(tok, String(p.midia_url), opcoesTikTok(p, cfg));
      await db.from("ig_planejados").update({ tiktok_publish_id: r.publish_id, tiktok_erro: null }).eq("id", p.id);
      await log("acao", p.conta_id, { tiktok: "enviado", planejado: p.id, modo: opcoesTikTok(p, cfg).modo, privacidade: r.privacidade || null });
      out.enviados++; out.itens.push({ id: p.id, titulo: p.titulo, acao: "enviado ao TikTok" });
    } catch (e) {
      const erro = String(e instanceof Error ? e.message : e).slice(0, 300);
      await db.from("ig_planejados").update({ tiktok_status: "erro", tiktok_erro: erro }).eq("id", p.id);
      await log("erro", p.conta_id, { onde: "tiktok enviar", planejado: p.id, erro }); out.erros++; out.itens.push({ id: p.id, titulo: p.titulo, erro });
    }
  }
  return out;
}

// opções do TikTok de um post: o que a pessoa escolheu na tela (tiktok_opcoes); sem escolha, vale o modo da conta e nunca "direto" às cegas
function opcoesTikTok(p: Row, cfg: Row): TkOpcoes {
  const o = ((p.tiktok_opcoes || {}) as TkOpcoes);
  const modo = o.modo || String(cfg.tiktok_modo || "rascunho");
  return { ...o, modo, titulo: o.titulo ?? [p.legenda, p.hashtags].filter(Boolean).join("\n\n").trim() };
}
// dados do criador para a tela de publicação (apelido, privacidade disponível, interações, duração máxima)
async function tiktokCriador(conta_id: string) {
  const tok = await tkToken(conta_id);
  if (!tok) throw new Error("TikTok não conectado nesta conta. Conecte em Contas.");
  const d = await tkCriador(tok);
  return { apelido: d.creator_nickname, usuario: d.creator_username, avatar: d.creator_avatar_url, privacidades: d.privacy_level_options || [], comentario_desativado: !!d.comment_disabled, dueto_desativado: !!d.duet_disabled, stitch_desativado: !!d.stitch_disabled, duracao_max: d.max_video_post_duration_sec || null };
}
// publica agora (a pessoa clicou em publicar na tela, com as opções já gravadas no post)
async function tiktokPublicar(planejado_id: string, quem: string) {
  const { data: p } = await db.from("ig_planejados").select("*").eq("id", planejado_id).single();
  if (!p) throw new Error("publicação não encontrada");
  if (!p.midia_url || p.tipo === "carrossel" || p.tipo === "story") throw new Error("O TikTok precisa de um vídeo. Envie o arquivo antes de publicar.");
  if (p.tiktok_status === "enviando") throw new Error("Este vídeo já está sendo enviado ao TikTok.");
  const { data: c } = await db.from("ig_contas").select("config").eq("id", p.conta_id).maybeSingle();
  const cfg = (c?.config || {}) as Row;
  const tok = await tkToken(p.conta_id);
  if (!tok) throw new Error("TikTok não conectado nesta conta. Conecte em Contas.");
  const o = opcoesTikTok(p, cfg);
  try {
    const r = await tkEnviarVideo(tok, String(p.midia_url), o);
    await db.from("ig_planejados").update({ tiktok_status: "enviando", tiktok_publish_id: r.publish_id, tiktok_erro: null, canais: [...new Set([...(p.canais || []), "tiktok"])] }).eq("id", p.id);
    await log("acao", p.conta_id, { tiktok: "enviado", por: quem, planejado: p.id, modo: o.modo, privacidade: r.privacidade || null });
    return { ok: true, publish_id: r.publish_id, modo: o.modo };
  } catch (e) {
    const erro = String(e instanceof Error ? e.message : e).slice(0, 300);
    await db.from("ig_planejados").update({ tiktok_status: "erro", tiktok_erro: erro }).eq("id", p.id);
    throw new Error(erro);
  }
}
// acompanha um envio (a tela consulta até concluir)
async function tiktokStatus(planejado_id: string) {
  const { data: p } = await db.from("ig_planejados").select("id,conta_id,tiktok_status,tiktok_publish_id,tiktok_erro,tiktok_url").eq("id", planejado_id).single();
  if (!p) throw new Error("publicação não encontrada");
  if (p.tiktok_status !== "enviando" || !p.tiktok_publish_id) return { status: p.tiktok_status, erro: p.tiktok_erro, url: p.tiktok_url };
  const tok = await tkToken(p.conta_id); if (!tok) return { status: p.tiktok_status };
  const st = await tkStatus(tok, String(p.tiktok_publish_id));
  const status = String(st.status || "");
  if (status === "SEND_TO_USER_INBOX") { await db.from("ig_planejados").update({ tiktok_status: "na_caixa", tiktok_erro: null }).eq("id", p.id); return { status: "na_caixa" }; }
  if (status === "PUBLISH_COMPLETE") {
    const ids = (st.publicaly_available_post_id as unknown[]) || []; const { data: c } = await db.from("ig_contas").select("config").eq("id", p.conta_id).maybeSingle(); const tk = ((c?.config || {}) as Row).tiktok;
    const url = ids[0] && tk ? `https://www.tiktok.com/@${tk}/video/${ids[0]}` : null;
    await db.from("ig_planejados").update({ tiktok_status: "publicado", tiktok_erro: null, ...(url ? { tiktok_url: url } : {}) }).eq("id", p.id); return { status: "publicado", url };
  }
  if (status === "FAILED") { const erro = `TikTok recusou: ${st.fail_reason || "sem motivo"}`; await db.from("ig_planejados").update({ tiktok_status: "erro", tiktok_erro: erro }).eq("id", p.id); return { status: "erro", erro }; }
  return { status: "enviando", fase: status };
}

// ======================= REFERÊNCIAS =======================
// A partir de um vídeo de referência (transcrição + legenda + números), a IA explica por que funcionou e escreve
// a NOSSA versão: roteiro original na voz da conta, nunca cópia. Cria um rascunho de reel no planejador.
async function roteiroDaReferencia(referencia_id: string, quem: string) {
  const { data: r } = await db.from("ig_referencias").select("*, ig_temas(nome,descricao)").eq("id", referencia_id).single();
  if (!r) throw new Error("referência não encontrada");
  const { data: conta } = await db.from("ig_contas").select("username,nome,biografia,config").eq("id", r.conta_id).maybeSingle();
  const cfgR = (conta?.config || {}) as Row;
  const voz = String(cfgR.voz || "").trim() || (cfgR.playbook !== "lidera" ? vozNeutra(conta as Row) : "") || "Charles, consultor de restaurantes do Programa Lucro e Liberdade: direto, de quem está na operação, fala com dono de restaurante.";
  const tema = (r.ig_temas || {}) as Row;
  const prompt = `Você é roteirista de Reels do perfil @${conta?.username}. Quem é e como fala:
${voz}

VÍDEO DE REFERÊNCIA (de @${r.perfil}, tema "${tema.nome || "geral"}"${tema.descricao ? ": " + tema.descricao : ""}):
- Números: ${r.plays ?? "?"} plays, ${r.curtidas ?? "?"} curtidas, ${r.comentarios ?? "?"} comentários, ${r.duracao ? Math.round(Number(r.duracao)) + " s" : "duração ?"}
- Legenda: ${String(r.legenda || "").slice(0, 1200)}
- Transcrição: ${String(r.transcricao || "(sem fala)").slice(0, 5000)}

TAREFA
1. Analise por que esse vídeo funciona: o gancho dos 3 primeiros segundos, a estrutura (blocos e viradas), o gatilho principal e o formato.
2. Escreva a NOSSA versão: um reel ORIGINAL, com a mesma estrutura que funciona, mas com história, exemplos, números e frases da vida real do dono do perfil. PROIBIDO copiar frases, piadas ou exemplos do vídeo de referência; só o esqueleto e o ângulo servem de inspiração. Se o tema não combinar com o perfil, adapte o ângulo para um dos assuntos dele.
3. Regras de escrita: português do Brasil falado, frases curtas, sem travessão, sem "você sabia que", no máximo 1 emoji na legenda.

Responda SÓ JSON:
{"analise":{"gancho":"o que ele faz nos 3 primeiros segundos","estrutura":"blocos em 1 a 2 linhas","por_que_funciona":"2 linhas","formato":"ex.: fala para a câmera, b-roll com narração, tela gravada"},
"titulo":"título interno do nosso vídeo","gancho":"nossa frase de abertura, até 12 palavras","roteiro":"roteiro cena a cena com o texto falado, 20 a 45 segundos","legenda":"legenda de 4 a 8 linhas terminando em pergunta ou CTA","cta":"...","hashtags":"5 a 8 hashtags"}`;
  const ia = parseJSON(await gemini(prompt, { json: true, temp: 0.8, esforco: "medium" })) as Row;
  const roteiro = `${String(ia.roteiro || "")}\n\n(Referência: @${r.perfil} · ${r.permalink || ""})`;
  const { data: pl, error } = await db.from("ig_planejados").insert({ conta_id: r.conta_id, data: somaDias(hoje(), 2), tipo: "reel", status: "rascunho", titulo: String(ia.titulo || "Reel a partir de referência"), gancho: String(ia.gancho || ""), roteiro, legenda: String(ia.legenda || ""), cta: String(ia.cta || ""), hashtags: String(ia.hashtags || ""), canais: ["instagram", "tiktok"], referencia_id, criado_por: quem }).select("id").single();
  if (error) throw error;
  await db.from("ig_referencias").update({ analise: { ...((r.analise as Row) || {}), ...((ia.analise as Row) || {}) }, status: "roteirizado", planejado_id: pl.id }).eq("id", referencia_id);
  return { ok: true, planejado_id: pl.id, analise: ia.analise, titulo: ia.titulo };
}

// Análise em português das referências ainda sem análise (em lotes): resumo do que é dito, gancho, estrutura e por que funcionou.
async function analisarReferencias(conta_id: string, limite = 5) {
  const { data: refs } = await db.from("ig_referencias").select("*").eq("conta_id", conta_id).is("analise", null).neq("status", "descartado").order("plays", { ascending: false, nullsFirst: false }).limit(limite);
  const { count } = await db.from("ig_referencias").select("id", { count: "exact", head: true }).eq("conta_id", conta_id).is("analise", null).neq("status", "descartado");
  let feitas = 0; const erros: string[] = [];
  for (const r of refs || []) {
    try {
      const prompt = `Você analisa Reels para um criador de conteúdo brasileiro. Responda em português do Brasil, direto, sem travessão.
REEL de @${r.perfil}: ${r.plays ?? "?"} plays, ${r.curtidas ?? "?"} curtidas, ${r.comentarios ?? "?"} comentários, ${r.duracao ? Math.round(Number(r.duracao)) + " s" : "?"}.
Legenda: ${String(r.legenda || "").slice(0, 1000)}
Transcrição da fala (pode estar em outro idioma): ${String(r.transcricao || "(sem fala)").slice(0, 5000)}
Responda SÓ JSON: {"resumo":"o que é dito no vídeo, em 2 a 3 linhas, em português","gancho":"o que prende nos 3 primeiros segundos","estrutura":"os blocos do vídeo em 1 a 2 linhas","por_que_funciona":"2 linhas: gatilho, identificação, formato","formato":"ex.: corte de palestra com legenda, fala para a câmera","cta":"o que a legenda pede (ex.: comente uma palavra-chave) e por que isso aumenta o alcance"}`;
      const ia = parseJSON(await gemini(prompt, { json: true, temp: 0.4 })) as Row;
      await db.from("ig_referencias").update({ analise: ia }).eq("id", r.id);
      feitas++;
    } catch (e) { erros.push(`${r.code}: ${String(e).slice(0, 100)}`); }
  }
  return { feitas, restantes: Math.max(0, (count || 0) - feitas), erros };
}

// ======================= FLUXOS =======================
// Reescreve com IA os textos das mensagens pendentes (ativar/followup) usando o passo ATUAL do fluxo como guia.
// Por padrão só as não aprovadas; `todas` inclui as já aprovadas (perde a edição humana). {conta_id, acao_id?, todas?}
// Em lotes (`limite`, padrão 6) para caber no tempo da Edge Function; o front chama de novo até `restantes` = 0.
// Já reescritas (`reescrito_em`) não entram de novo (salvo `todas`).
async function reescreverTextos(conta_id: string, acao_id: string | null, todas: boolean, limite = 6) {
  let q = db.from("ig_acoes").select("*, ig_leads(*)").eq("status", "pendente").in("tipo", ["ativar", "followup"]).not("lead_id", "is", null).order("criado_em").limit(limite);
  if (acao_id) q = q.eq("id", acao_id); else q = q.eq("conta_id", conta_id);
  if (!todas) q = q.eq("aprovado", false).is("reescrito_em", null);
  const { data: acs } = await q;
  let restantes = 0;
  if (!acao_id) { const { count } = await db.from("ig_acoes").select("id", { count: "exact", head: true }).eq("conta_id", conta_id).eq("status", "pendente").in("tipo", ["ativar", "followup"]).eq("aprovado", false).is("reescrito_em", null); restantes = Math.max(0, (count || 0) - (acs?.length || 0)); }
  const out = { total: acs?.length || 0, reescritas: 0, puladas: 0, restantes, erros: [] as string[] };
  for (const a of acs || []) {
    const l = (a.ig_leads || {}) as Row;
    if (l.icp === "nao_passa") { out.puladas++; continue; }
    try {
      const fx = await fluxoDaConta(String(a.conta_id), String(l.fluxo || "NS"));
      const passo = fx.passos.find((p) => p.id === a.passo_id) || fx.passos.filter((p) => p.tipo === "mensagem")[a.tipo === "ativar" ? 0 : Math.max(1, Number(l.toques || 1))] || null;
      const perfil = (l.perfil || {}) as Row;
      const prompt = `${PLAYBOOK_IA}

PASSO DO FLUXO (${fx.nome}) a escrever agora: ${passo?.titulo || a.titulo}
MODELO DO PASSO, use como base e troque [Nome], [restaurante], [conexao], [dia/tarde] e [pergunta factual] por conteúdo real:
${passo?.texto || "(mensagem curta de conexão)"}

LEAD: @${l.username} · nome: ${l.nome || "?"} · restaurante: ${l.restaurante || "desconhecido"} · cidade: ${l.cidade || "?"} · segmento: ${l.segmento || "?"} · conexão já anotada: ${l.conexao || "nenhuma"} · triagem: ${l.pesquisa || "?"} · sinal: ${l.sinal_calor || "?"}
PERFIL (texto da página, pode estar vazio): ${JSON.stringify(perfil).slice(0, 4000)}
Hora atual: ${saudacao()}.

REGRAS: 3 a 4 linhas, tom de WhatsApp, uma pergunta só no final. NUNCA deixe lacuna entre colchetes. Se o restaurante é desconhecido, não invente: fale do que dá para ver no perfil e pergunte o que ele toca. Não cite "Programa de Aceleração" nem venda nada neste passo, a não ser que o modelo do passo seja a mensagem de venda (aí siga o modelo). Sem emoji na saudação.
Responda SÓ JSON: {"mensagem":"texto pronto para colar"}`;
      const ia = parseJSON(await gemini(prompt, { json: true, temp: 0.7 })) as Row;
      const texto = String(ia.mensagem || "").trim();
      if (!texto || temPlaceholder(texto)) { out.erros.push(`@${l.username}: texto vazio ou com lacuna`); continue; }
      await db.from("ig_acoes").update({ texto, texto_sugerido: texto, reescrito_em: new Date().toISOString(), titulo: `${passo?.titulo || a.titulo.split(":")[0]}: @${l.username}` }).eq("id", a.id);
      out.reescritas++;
    } catch (e) { out.erros.push(`@${l.username}: ${String(e).slice(0, 120)}`); }
  }
  await log("ia", conta_id, { reescrever: out });
  return out;
}

async function fluxoDaConta(conta_id: string, codigo: string): Promise<Fluxo> {
  const { data } = await db.from("ig_fluxos").select("*").eq("conta_id", conta_id).eq("codigo", codigo).maybeSingle();
  if (data) return { codigo: data.codigo, nome: data.nome, descricao: data.descricao, ativo: data.ativo, so_icp: data.so_icp, passos: (data.passos || []) as Passo[] };
  return FLUXOS_PADRAO.find((f) => f.codigo === codigo) || FLUXOS_PADRAO[3];
}

// Coloca o lead no fluxo dele: cria as ações até a 1ª mensagem (D1 reciprocidade hoje, D2 conexão amanhã).
// As mensagens seguintes (D4 venda) nascem pela fila do dia, só se o lead não responder.
async function entrarNoFluxo(lead_id: string, quem: string, mensagemIA?: string) {
  const { data: l } = await db.from("ig_leads").select("*").eq("id", lead_id).single();
  if (!l) throw new Error("lead não encontrado");
  const fx = await fluxoDaConta(l.conta_id, l.fluxo || "NS");
  if (!fx.ativo) return { fluxo: fx.codigo, ativo: false };
  if (fx.so_icp && l.icp === "nao_passa") return { fluxo: fx.codigo, pulado: "fora de ICP" };
  const { data: ja } = await db.from("ig_acoes").select("passo_id").eq("lead_id", lead_id).not("passo_id", "is", null);
  const feitos = new Set((ja || []).map((a) => a.passo_id));
  const msgs = fx.passos.filter((p) => p.tipo === "mensagem");
  const rows: Row[] = [];
  let dia = 0, primeiraMsg = true;
  for (const p of fx.passos) {
    if (p.tipo === "mensagem" && !primeiraMsg) break; // follow-ups ficam para a fila
    dia += p.dia || 0; // D2 sai no dia seguinte ao D1
    if (feitos.has(p.id)) { if (p.tipo === "mensagem") primeiraMsg = false; continue; }
    const tipo = TIPO_PARA_ACAO[p.tipo] || p.tipo;
    const url = tipo === "ativar" ? `https://ig.me/m/${l.username}` : tipo === "reagir_story" ? `https://www.instagram.com/stories/${l.username}/` : `https://www.instagram.com/${l.username}/`;
    let texto = p.texto ? preencher(p.texto, l, saudacao()) : "";
    if (p.tipo === "mensagem") { if (mensagemIA && p.ia) texto = mensagemIA; primeiraMsg = false; }
    if (p.tipo === "comentar" && l.comentario_id) {
      rows.push({ conta_id: l.conta_id, lead_id, comentario_id: l.comentario_id, passo_id: p.id, automatico: !!p.automatico, data: somaDias(hoje(), dia), bloco: BLOCO_POR_FLUXO[fx.codigo] || 4, tipo: "responder_comentario", titulo: `${p.titulo}: @${l.username}`, texto: "", origem: `fluxo:${fx.codigo}:${p.id}`, url: `https://www.instagram.com/${l.username}/` });
      continue;
    }
    rows.push({ conta_id: l.conta_id, lead_id, passo_id: p.id, automatico: !!p.automatico && p.tipo === "mensagem", data: somaDias(hoje(), dia), bloco: BLOCO_POR_FLUXO[fx.codigo] || 4, tipo, titulo: `${p.titulo}: @${l.username}`, texto, origem: `fluxo:${fx.codigo}:${p.id}`, url });
  }
  if (rows.length) await db.from("ig_acoes").insert(rows);
  if (l.etapa === "novo" || l.etapa === "icp" || (l.etapa === "aquecendo" && !l.aquecido_em)) await db.from("ig_leads").update({ etapa: "aquecendo", aquecido_em: hoje(), ...(l.icp !== "nao_passa" && l.etapa === "icp" ? { icp: "passa" } : {}) }).eq("id", lead_id);
  return { fluxo: fx.codigo, acoes: rows.length, mensagens_no_fluxo: msgs.length };
}

// Executa pela API oficial as ações marcadas como automáticas (cron a cada 15 min):
//  - responder_comentario: resposta pública (IA)
//  - ativar/followup com canal oficial: resposta privada ao comentário (até 7 dias) ou conversa já aberta no direct
async function executarFluxos(conta_id: string) {
  const ids = conta_id ? [conta_id] : ((await db.from("ig_contas").select("id").eq("ativo", true)).data || []).map((c) => c.id as string);
  const out: Row = {};
  for (const cid of ids) {
    const tok = await tokenDaConta(cid);
    if (!tok) { out[cid] = "sem token"; continue; }
    const { data: conta } = await db.from("ig_contas").select("config,conectado_em").eq("id", cid).single();
    const cfg = (conta?.config || {}) as Row;
    if (cfg.auto === false) { out[cid] = "automático desligado"; continue; }
    const inicio = (cfg.inicio as string) || String(conta?.conectado_em || "").slice(0, 10);
    const dias = Math.max(0, Math.round((Date.now() - new Date(inicio).getTime()) / 864e5));
    const limite = Number(cfg.max_dia) > 0 ? limiteDiario(dias, Number(cfg.max_dia)) : Infinity; // sem teto diário, salvo config.max_dia
    const { count: enviadas } = await db.from("ig_acoes").select("id", { count: "exact", head: true }).eq("conta_id", cid).eq("data", hoje()).eq("status", "feita").eq("feita_por", "api").in("tipo", ["ativar", "followup"]);
    let msgs = enviadas || 0;
    const aprovacao = cfg.modo === "aprovacao";
    const { data: acoes } = await db.from("ig_acoes").select("*, ig_leads(*)").eq("conta_id", cid).eq("status", "pendente").eq("automatico", true).lte("data", hoje()).order("criado_em").limit(40);
    const r: Row = { comentarios: 0, mensagens: 0, sem_canal: 0, erros: 0, preparadas: 0, modo: aprovacao ? "aprovacao" : "automatico" };
    for (const a of acoes || []) {
      const l = a.ig_leads as Row | null;
      try {
        if (a.tipo === "responder_comentario" && a.comentario_id) {
          // modo aprovação: prepara a sugestão (fica visível em Aprovações) e só envia depois do OK
          let texto = String(a.texto_sugerido || "");
          if (!texto) { const ia = await sugerir("comentario", a.comentario_id); texto = String(ia.resposta_publica || ""); await db.from("ig_acoes").update({ texto_sugerido: texto }).eq("id", a.id); r.preparadas = (r.preparadas as number) + 1; }
          if (aprovacao && !a.aprovado) continue;
          const final = String(a.aprovado && a.texto_sugerido ? a.texto_sugerido : texto);
          await responderComentario(a.comentario_id, final, "api");
          await db.from("ig_acoes").update({ status: "feita", feita_em: new Date().toISOString(), feita_por: "api", texto: final }).eq("id", a.id);
          r.comentarios = (r.comentarios as number) + 1; continue;
        }
        if (aprovacao && !a.aprovado) continue;
        if (a.tipo === "ativar" || a.tipo === "followup") {
          if (msgs >= limite) continue;
          if (!a.texto || temPlaceholder(a.texto)) continue; // texto incompleto fica para a pessoa
          if (l?.icp === "nao_passa") { await db.from("ig_acoes").update({ status: "pulada", feita_por: "api" }).eq("id", a.id); continue; }
          if (l?.icp !== "passa" && !a.aprovado) continue; // "a confirmar" só com aprovação humana
          let enviado = false;
          // canal 1: conversa já aberta no direct
          const { data: cv } = await db.from("ig_conversas").select("id,participante_id").eq("conta_id", cid).eq("lead_id", a.lead_id).maybeSingle();
          if (cv?.participante_id) { await graphPost("me/messages", tok, { recipient: { id: cv.participante_id }, message: { text: a.texto } }); enviado = true; await registrarEnvio(cv.id, cid, a.texto); }
          // canal 2: resposta privada ao comentário (válida por 7 dias)
          else if (l?.comentario_id) {
            const { data: c } = await db.from("ig_comentarios").select("criado_em").eq("id", l.comentario_id).maybeSingle();
            if (c && Date.now() - new Date(c.criado_em).getTime() < 7 * 864e5) { await graphPost("me/messages", tok, { recipient: { comment_id: l.comentario_id }, message: { text: a.texto } }); enviado = true; }
          }
          if (!enviado) { r.sem_canal = (r.sem_canal as number) + 1; continue; } // fica na fila para a pessoa
          msgs++;
          const toques = Number(l?.toques || 0) + 1;
          const prox = proximaMensagem(await fluxoDaConta(cid, String(l?.fluxo || "NS")), toques);
          await db.from("ig_acoes").update({ status: "feita", feita_em: new Date().toISOString(), feita_por: "api" }).eq("id", a.id);
          await db.from("ig_leads").update({ etapa: "ativado", toques, ultimo_toque: new Date().toISOString(), proximo_toque: prox ? somaDias(hoje(), prox.dia || 2) : null, ...(prox ? {} : { etapa: "frio" }) }).eq("id", a.lead_id);
          r.mensagens = (r.mensagens as number) + 1;
          await log("acao", cid, { api: a.tipo, lead: l?.username, passo: a.passo_id });
        }
      } catch (e) { r.erros = (r.erros as number) + 1; await log("erro", cid, { onde: "executarFluxos", acao: a.id, erro: String(e).slice(0, 250) }); }
    }
    out[cid] = r;
  }
  return out;
}
async function registrarEnvio(conversa_id: string, conta_id: string, texto: string) {
  const agora = new Date().toISOString();
  await db.from("ig_mensagens").insert({ id: `api:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, conversa_id, conta_id, de_mim: true, texto, tipo: "texto", criado_em: agora, lido: true });
  await db.from("ig_conversas").update({ ultima_msg: texto, ultima_em: agora, ultima_de_mim: true, nao_lidas: 0 }).eq("id", conversa_id);
}

// ======================= FILA DO DIA =======================
async function gerarFila(conta_id: string, data: string) {
  if (!conta_id) throw new Error("conta_id obrigatório");
  const { data: conta } = await db.from("ig_contas").select("*").eq("id", conta_id).single();
  const cfg = (conta.config || {}) as Row;
  if (cfg.perfil === "conteudo") return { novas: 0, motivo: "conta de conteúdo: sem rotina de social selling" };
  const dow = new Date(data + "T12:00:00-03:00").getDay();
  const inicio = (cfg.inicio as string) || (conta.conectado_em as string).slice(0, 10);
  const dias = Math.max(0, Math.round((new Date(data).getTime() - new Date(inicio).getTime()) / 864e5));
  const limite = Number(cfg.max_dia) > 0 ? limiteDiario(dias, Number(cfg.max_dia)) : Infinity; // sem teto diário, salvo config.max_dia
  const { data: existentes } = await db.from("ig_acoes").select("tipo,lead_id,conversa_id,comentario_id,origem").eq("conta_id", conta_id).eq("data", data);
  const ja = new Set((existentes || []).map((a) => `${a.tipo}|${a.lead_id || a.conversa_id || a.comentario_id || a.origem}`));
  const novas: Row[] = [];
  const add = (a: Row) => { const k = `${a.tipo}|${a.lead_id || a.conversa_id || a.comentario_id || a.origem}`; if (!ja.has(k)) { ja.add(k); novas.push({ conta_id, data, status: "pendente", ...a }); } };

  // 1) story de captura (seg a sex)
  const sc = STORY_CAPTURA[dow];
  if (sc && !(cfg.sem_story_captura)) {
    add({ bloco: 1, tipo: "story_captura", titulo: `08:30 · Story de captura: ${sc.formato}`, texto: sc.texto, origem: "rotina:story1", url: "https://www.instagram.com/" });
    add({ bloco: 6, tipo: "story_captura", titulo: "14:00 · Segundo story + plantão no direct", texto: "Publica o segundo story do dia e fica no direct por 30 min. Atraso de 1 hora corta a conversão pela metade.", origem: "rotina:story2", url: "https://www.instagram.com/" });
  }
  // 2) inbound: comentários sem resposta e DMs não lidas
  const { data: coms } = await db.from("ig_comentarios").select("id,autor_username,texto,lead_id").eq("conta_id", conta_id).eq("de_mim", false).eq("respondido", false).eq("oculto", false).is("parent_id", null).order("criado_em", { ascending: false }).limit(40);
  for (const c of coms || []) add({ bloco: 2, tipo: "responder_comentario", comentario_id: c.id, lead_id: c.lead_id, titulo: `Responder @${c.autor_username} no post`, texto: c.texto, origem: "rotina:comentarios", url: `https://www.instagram.com/${c.autor_username}/` });
  const { data: convs } = await db.from("ig_conversas").select("id,participante_username,ultima_msg,lead_id,nao_lidas,ultima_de_mim").eq("conta_id", conta_id).eq("arquivada", false).gt("nao_lidas", 0).order("ultima_em", { ascending: false }).limit(60);
  for (const c of convs || []) add({ bloco: 2, tipo: "responder_dm", conversa_id: c.id, lead_id: c.lead_id, titulo: `Responder @${c.participante_username} no direct`, texto: c.ultima_msg, origem: "rotina:inbox", url: `https://ig.me/m/${c.participante_username}` });
  // 3) conversas abertas nas camadas 2-4 onde a última é dele e já foi lida
  const { data: abertas } = await db.from("ig_leads").select("id,username,etapa,conversa_id").eq("conta_id", conta_id).in("etapa", ["rmv", "desafio", "escada", "convite"]).limit(80);
  for (const l of abertas || []) {
    const { data: cv } = await db.from("ig_conversas").select("id,ultima_de_mim,nao_lidas").eq("conta_id", conta_id).or(`lead_id.eq.${l.id}${l.conversa_id ? `,id.eq.${l.conversa_id}` : ""}`).maybeSingle();
    if (cv && cv.ultima_de_mim === false && !cv.nao_lidas) add({ bloco: 3, tipo: "avancar", conversa_id: cv.id, lead_id: l.id, titulo: `Avançar @${l.username} (${ETAPAS[l.etapa]})`, origem: "rotina:conversas", url: `https://ig.me/m/${l.username}` });
  }
  // 4) novos seguidores / leads novos: triagem (até 20)
  const { data: novosLeads } = await db.from("ig_leads").select("id,username,fluxo").eq("conta_id", conta_id).eq("etapa", "novo").in("fluxo", ["SC", "RS", "CP", "NS"]).order("criado_em", { ascending: false }).limit(20);
  for (const l of novosLeads || []) add({ bloco: 4, tipo: "triagem", lead_id: l.id, titulo: `Triagem de @${l.username} (${l.fluxo})`, texto: "60 segundos: dono? restaurante? ativo? Sinal de calor? Se passa, pesquisar e ativar.", origem: "rotina:triagem", url: `https://www.instagram.com/${l.username}/` });
  // 4b) ICP aprovado esperando o D1: seguir, curtir 3 fotos, reagir a story e mover para Aquecendo (gera o D2)
  const { data: icps } = await db.from("ig_leads").select("id,username,fluxo").eq("conta_id", conta_id).eq("etapa", "icp").order("atualizado_em", { ascending: false }).limit(25);
  for (const l of icps || []) add({ bloco: 4, tipo: "aquecer", lead_id: l.id, titulo: `D1 de @${l.username}: seguir, curtir 3 fotos e reagir a 1 story`, texto: "Ao concluir, marque como feita: o lead vai para Aquecendo e a mensagem D2 fica agendada para amanhã.", origem: "rotina:aquecer", url: `https://www.instagram.com/${l.username}/` });
  // 5) follow-ups: próximo passo de mensagem do fluxo do lead (só quem não respondeu)
  const { data: fups } = await db.from("ig_leads").select("*").eq("conta_id", conta_id).eq("etapa", "ativado").lte("proximo_toque", data).limit(40);
  for (const l of fups || []) {
    const fx = await fluxoDaConta(conta_id, l.fluxo || "NS");
    const prox = proximaMensagem(fx, l.toques || 1);
    if (!prox) continue;
    add({ bloco: 5, tipo: "followup", lead_id: l.id, passo_id: prox.id, automatico: !!prox.automatico, titulo: `${prox.titulo}: @${l.username}`, texto: preencher(prox.texto || "", l, saudacao()), origem: `fluxo:${fx.codigo}:${prox.id}`, url: `https://ig.me/m/${l.username}` });
  }
  // 7) visita sincera: frios há 60+ dias e leads sem toque há 30 dias (até 25)
  const corte60 = somaDias(data, -60), corte30 = somaDias(data, -30);
  const { data: frios } = await db.from("ig_leads").select("id,username").eq("conta_id", conta_id).eq("etapa", "frio").lte("ultimo_toque", corte60 + "T23:59:59").limit(25);
  for (const l of frios || []) add({ bloco: 7, tipo: "visita", lead_id: l.id, titulo: `Visita sincera: @${l.username} (frio há 60 dias)`, texto: "Ver stories, reagir a 1, curtir o último post. Se tiver gancho novo, reativar com pergunta factual nova.", origem: "rotina:vs", url: `https://www.instagram.com/stories/${l.username}/` });
  const { data: quentes } = await db.from("ig_leads").select("id,username").eq("conta_id", conta_id).in("etapa", ["rmv", "desafio", "escada", "convite", "agendado_charles", "agendado_guilherme"]).lte("ultimo_toque", corte30 + "T23:59:59").limit(10);
  for (const l of quentes || []) add({ bloco: 7, tipo: "reagir_story", lead_id: l.id, titulo: `Manter calor: reagir a 1 story de @${l.username}`, origem: "rotina:calor", url: `https://www.instagram.com/stories/${l.username}/` });
  // 8) outbound: leads OB em aquecimento sem ação hoje
  const { data: obs } = await db.from("ig_leads").select("id,username").eq("conta_id", conta_id).eq("fluxo", "OB").eq("etapa", "novo").limit(15);
  for (const l of obs || []) add({ bloco: 8, tipo: "pesquisa", lead_id: l.id, titulo: `Outbound: pesquisar e aquecer @${l.username}`, texto: "Dia 0: segue, curte 3 posts, vê todos os stories e reage a 1. Use 'Pesquisar com IA' no lead para gerar a conexão e a mensagem.", origem: "rotina:ob", url: `https://www.instagram.com/${l.username}/` });
  // 9) fechamento
  add({ bloco: 9, tipo: "registrar", titulo: "16:30 · LeadForge, confirmações de amanhã (D-1 às 18h) e números do dia", texto: "Registrar no LeadForge todo lead tocado hoje (campos: desafio nas palavras dele + o que mudaria). Mandar confirmação D-1 para os diagnósticos de amanhã.", origem: "rotina:fechamento" });

  if (novas.length) await db.from("ig_acoes").insert(novas);
  // teto de mensagens novas do dia (ativar + followup): as excedentes são ADIADAS para o próximo dia útil (nunca perdidas)
  const { data: msgsHoje } = await db.from("ig_acoes").select("id").eq("conta_id", conta_id).eq("data", data).in("tipo", ["ativar", "followup"]).eq("status", "pendente").order("bloco").order("criado_em");
  const excedentes = Number.isFinite(limite) ? (msgsHoje || []).slice(limite) : [];
  const amanha = somaDias(data, dow === 6 ? 2 : 1);
  if (excedentes.length) await db.from("ig_acoes").update({ data: amanha, origem_adiada: data }).in("id", excedentes.map((a) => a.id));
  await log("fila", conta_id, { data, novas: novas.length, limite: Number.isFinite(limite) ? limite : null, dias_operacao: dias, excedentes: excedentes.length });
  return { novas: novas.length, limite: Number.isFinite(limite) ? limite : null, dias_operacao: dias, excedentes: excedentes.length };
}

function somaDias(d: string, n: number) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
