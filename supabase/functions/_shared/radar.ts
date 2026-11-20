// Radar de referências: perfis públicos (empresa ou criador) acompanhados pela API oficial da Meta (Business Discovery).
// A consulta exige um token do Facebook (usuário do sistema do BM) com instagram_basic + pages_show_list +
// pages_read_engagement, e uma conta do Instagram ligada a uma Página. Esse token fica SÓ no hub (segredo IG_FB_TOKEN).
// Os painéis pedem ao hub, com a assinatura deles; o hub confere e responde. Nada é raspado do Instagram.
import { admin, log } from "./ig.ts";
import { hubAssinar, hubDoPainel, nomeDoPainel } from "./hub.ts";

type Row = Record<string, unknown>;
const FB = "https://graph.facebook.com/v26.0";
const FB_TOKEN = Deno.env.get("IG_FB_TOKEN") || "";
const CAMPOS_PERFIL = "username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url";
// do mais completo ao mínimo: se a Meta recusar um campo, tenta o próximo conjunto
const CAMPOS_POSTS = [
  "id,caption,like_count,comments_count,media_type,media_product_type,permalink,timestamp,view_count,thumbnail_url,media_url",
  "id,caption,like_count,comments_count,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url",
  "id,caption,like_count,comments_count,media_type,permalink,timestamp",
];

export const radarLocal = () => !!FB_TOKEN;

let contaIg = Deno.env.get("IG_FB_CONTA") || "";
async function fb(path: string, params: Record<string, string>) {
  const u = new URL(`${FB}/${path}`);
  Object.entries({ ...params, access_token: FB_TOKEN }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${j.error?.message || r.status} (code ${j.error?.code ?? "?"})`);
  return j;
}
// a conta do Instagram que faz as consultas: a primeira ligada às Páginas que o token enxerga
async function contaConsulta(): Promise<string> {
  if (contaIg) return contaIg;
  const j = await fb("me/accounts", { fields: "name,instagram_business_account{id,username}", limit: "50" });
  const p = (j.data || []).find((x: Row) => (x.instagram_business_account as Row)?.id);
  if (!p) throw new Error("o token do Facebook não enxerga nenhuma Página com Instagram ligado");
  contaIg = String((p.instagram_business_account as Row).id);
  return contaIg;
}

// Consulta oficial de um perfil (no hub, com o token do Facebook)
export async function descobrirLocal(username: string, limite = 30): Promise<Row> {
  const u = username.replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(u)) return { username: u, erro: "@ inválido" };
  const ig = await contaConsulta();
  let ultimo = "";
  for (const campos of CAMPOS_POSTS) {
    try {
      const j = await fb(ig, { fields: `business_discovery.username(${u}){${CAMPOS_PERFIL},media.limit(${limite}){${campos}}}` });
      const bd = (j.business_discovery || {}) as Row;
      return { ...bd, username: u, posts: ((bd.media as Row)?.data as Row[]) || [] };
    } catch (e) {
      ultimo = String(e);
      if (!/nonexisting field|Tried accessing nonexisting|not supported|Invalid parameter/i.test(ultimo)) break;
    }
  }
  const msg = /2207013|cannot be found|does not exist|not found/i.test(ultimo)
    ? "perfil não encontrado ou não é conta profissional (empresa ou criador); a Meta só mostra esses"
    : ultimo.replace(/^Error:\s*/, "").slice(0, 220);
  return { username: u, erro: msg };
}

// Em qualquer projeto: consulta local (se for o hub) ou pede ao hub, assinado
export async function descobrir(usernames: string[]): Promise<Row[]> {
  if (radarLocal()) {
    const out: Row[] = [];
    for (const u of usernames) out.push(await descobrirLocal(u));
    return out;
  }
  const [hub, nome] = await Promise.all([hubDoPainel(), nomeDoPainel()]);
  if (!hub || !nome) throw new Error("radar sem consulta: falta o token do Facebook (IG_FB_TOKEN) neste projeto ou um hub configurado");
  const corpo = JSON.stringify({ ts: Date.now(), usernames });
  const r = await fetch(`${hub}/ig-api/radar/descobrir`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-painel": nome, "x-painel-assinatura": await hubAssinar(corpo) },
    body: corpo, signal: AbortSignal.timeout(140000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.erro) throw new Error("hub: " + (j.erro || r.status));
  return j.perfis || [];
}

const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
async function gravarPosts(cid: string, u: string, posts: Row[], agora: string): Promise<string | null> {
  if (!posts.length) return null;
  const { error } = await admin().from("ig_ref_posts").upsert(posts.map((m) => ({
    conta_id: cid, id: String(m.id), perfil: u, permalink: m.permalink ?? null, tipo: m.media_type ?? null, produto: m.media_product_type ?? null,
    legenda: String(m.caption || "").slice(0, 2200), curtidas: num(m.like_count), comentarios: num(m.comments_count), views: num(m.view_count),
    thumb: (m.thumbnail_url || (m.media_type === "IMAGE" ? m.media_url : null)) ?? null, publicado_em: m.timestamp ?? null, atualizado_em: agora,
  })), { onConflict: "conta_id,id" });
  return error ? error.message : null;
}
const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Atualiza os perfis de referência de uma conta (ou de todas): perfil, posts com métricas e histórico do dia.
export async function radarAtualizar(conta_id?: string, so?: string[]) {
  const db = admin();
  let q = db.from("ig_perfis_ref").select("id,conta_id,username");
  if (conta_id) q = q.eq("conta_id", conta_id);
  const { data: refs } = await q;
  const alvo = (refs || []).filter((r) => !so?.length || so.map((x) => x.toLowerCase()).includes(String(r.username).toLowerCase()));
  const porConta = new Map<string, Set<string>>();
  for (const r of alvo) { const s = porConta.get(String(r.conta_id)) || new Set<string>(); s.add(String(r.username).toLowerCase()); porConta.set(String(r.conta_id), s); }
  const todos = [...new Set(alvo.map((r) => String(r.username).toLowerCase()))];
  const res: Record<string, Row> = {};
  for (let i = 0; i < todos.length; i += 8) for (const p of await descobrir(todos.slice(i, i + 8))) res[String(p.username)] = p;
  const hoje = new Date().toISOString().slice(0, 10), agora = new Date().toISOString();
  const resumo = { perfis: 0, posts: 0, erros: [] as string[] };
  for (const [cid, users] of porConta) {
    for (const u of users) {
      const p = res[u];
      if (!p || p.erro) { await db.from("ig_perfis_ref").update({ radar_erro: String(p?.erro || "sem resposta"), radar_em: agora }).eq("conta_id", cid).eq("username", u); resumo.erros.push(`@${u}: ${p?.erro || "sem resposta"}`); continue; }
      const posts = (p.posts as Row[]) || [];
      const seguidores = num(p.followers_count);
      const d30 = Date.now() - 30 * 864e5, d28 = Date.now() - 28 * 864e5;
      const recentes = posts.filter((m) => new Date(String(m.timestamp)).getTime() >= d30);
      const base = recentes.length >= 3 ? recentes : posts.slice(0, 12);
      const eng = media(base.map((m) => (num(m.like_count) || 0) + (num(m.comments_count) || 0)));
      const views = media(base.map((m) => num(m.view_count)).filter((v): v is number => v != null && v > 0));
      const perfil = {
        nome: p.name ?? null, bio: p.biography ?? null, site: p.website ?? null, foto: p.profile_picture_url ?? null,
        seguidores, seguindo: num(p.follows_count), posts: num(p.media_count),
        eng_medio: eng, taxa_eng: eng != null && seguidores ? eng / seguidores : null, views_medio: views,
        posts_semana: posts.filter((m) => new Date(String(m.timestamp)).getTime() >= d28).length / 4,
        radar_em: agora, radar_erro: null,
      };
      await db.from("ig_perfis_ref").update(perfil).eq("conta_id", cid).eq("username", u);
      const ePosts = await gravarPosts(cid, u, posts, agora);
      if (ePosts) resumo.erros.push(`@${u} posts: ${ePosts}`);
      await db.from("ig_ref_historico").upsert({ conta_id: cid, perfil: u, data: hoje, seguidores, posts: num(p.media_count), eng_medio: eng, views_medio: views }, { onConflict: "conta_id,perfil,data" });
      resumo.perfis++; resumo.posts += posts.length;
    }
  }
  await log("radar", conta_id || null, resumo);
  return resumo;
}

// ---------- histórico completo: todos os posts de cada perfil, página por página ----------
// A Meta entrega os posts de um perfil em páginas (cursor). O histórico é carregado aos poucos, a cada 30 min,
// respeitando o limite de chamadas da conta que consulta; o botão "Carregar tudo" da tela acelera um perfil.
const LIMITE_CHAMADAS = /\(code (4|17|32|613|80002)\)|rate limit|too many calls|limite de chamadas/i;

export async function paginaLocal(username: string, after: string | null, limite = 100): Promise<Row> {
  const u = username.replace(/^@/, "").trim().toLowerCase();
  const ig = await contaConsulta();
  let ultimo = "";
  for (const lim of [limite, 50, 25]) {
    for (const campos of CAMPOS_POSTS) {
      try {
        const media = `media${after ? `.after(${after})` : ""}.limit(${lim}){${campos}}`;
        const j = await fb(ig, { fields: `business_discovery.username(${u}){followers_count,${media}}` });
        const m = ((j.business_discovery || {}) as Row).media as Row | undefined;
        const paging = (m?.paging || {}) as Row;
        const posts = (m?.data as Row[]) || [];
        // a Business Discovery nem sempre manda "next": segue pelo marcador enquanto a página vier cheia
        const depois = ((paging.cursors as Row)?.after as string) || null;
        const next = depois && depois !== after && posts.length > 0 && (paging.next || posts.length >= lim) ? depois : null;
        return { username: u, posts, next };
      } catch (e) {
        ultimo = String(e);
        if (/nonexisting field|Tried accessing nonexisting|not supported/i.test(ultimo)) continue; // tenta menos campos
        if (/reduce the amount of data|Please reduce/i.test(ultimo)) break; // tenta páginas menores
        return { username: u, erro: ultimo.replace(/^Error:\s*/, "").slice(0, 220) };
      }
    }
  }
  return { username: u, erro: ultimo.replace(/^Error:\s*/, "").slice(0, 220) };
}

export async function pagina(username: string, after: string | null): Promise<Row> {
  if (radarLocal()) return paginaLocal(username, after);
  const [hub, nome] = await Promise.all([hubDoPainel(), nomeDoPainel()]);
  if (!hub || !nome) throw new Error("radar sem consulta: falta o token do Facebook (IG_FB_TOKEN) neste projeto ou um hub configurado");
  const corpo = JSON.stringify({ ts: Date.now(), username, after });
  const r = await fetch(`${hub}/ig-api/radar/pagina`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-painel": nome, "x-painel-assinatura": await hubAssinar(corpo) },
    body: corpo, signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.erro && !j.username)) throw new Error("hub: " + (j.erro || r.status));
  return j;
}

// Avança o histórico dos perfis que ainda não estão completos (ou de um perfil só), dentro de um tempo e de um número de páginas.
export async function radarHistorico(conta_id?: string, username?: string, maxPaginas = 25, orcamentoMs = 100000) {
  const db = admin();
  const t0 = Date.now();
  let q = db.from("ig_perfis_ref").select("conta_id,username,hist_cursor,hist_completo").or("hist_completo.is.null,hist_completo.eq.false");
  if (conta_id) q = q.eq("conta_id", conta_id);
  if (username) q = q.eq("username", username.replace(/^@/, "").toLowerCase());
  const { data } = await q;
  const fila = [...new Map((data || []).map((r) => [`${r.conta_id}|${String(r.username).toLowerCase()}`, r])).values()];
  const out = { paginas: 0, posts: 0, completos: [] as string[], pendentes: 0, parou: "" };
  for (const r of fila) {
    const cid = String(r.conta_id), u = String(r.username).toLowerCase();
    let cursor = (r.hist_cursor as string) || null;
    while (out.paginas < maxPaginas && Date.now() - t0 < orcamentoMs) {
      const p = await pagina(u, cursor);
      out.paginas++;
      if (p.erro) {
        await db.from("ig_perfis_ref").update({ radar_erro: String(p.erro), hist_em: new Date().toISOString() }).eq("conta_id", cid).eq("username", u);
        if (LIMITE_CHAMADAS.test(String(p.erro))) { out.parou = "limite de chamadas da Meta; continua na próxima rodada"; break; }
        break;
      }
      const agora = new Date().toISOString();
      const posts = (p.posts as Row[]) || [];
      await gravarPosts(cid, u, posts, agora);
      out.posts += posts.length;
      cursor = (p.next as string) || null;
      await db.from("ig_perfis_ref").update({ hist_cursor: cursor, hist_completo: !cursor, hist_em: agora }).eq("conta_id", cid).eq("username", u);
      if (!cursor) { out.completos.push(u); break; }
    }
    if (out.parou || out.paginas >= maxPaginas || Date.now() - t0 >= orcamentoMs) break;
  }
  const { count } = await db.from("ig_perfis_ref").select("id", { count: "exact", head: true }).or("hist_completo.is.null,hist_completo.eq.false").match(conta_id ? { conta_id } : {});
  out.pendentes = count || 0;
  if (out.paginas) await log("radar", conta_id || null, { historico: out });
  return out;
}
