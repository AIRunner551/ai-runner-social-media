// Edge Function: ig-auth
// Login com Instagram (Instagram API with Instagram Login). Fluxo:
//   GET /ig-auth/start?u=<email>      -> redireciona para a tela de autorização do Instagram
//   GET /ig-auth/callback?code=...    -> troca o code por token curto, depois longo (60 dias), salva a conta
//   POST /ig-auth/refresh {conta_id}  -> renova o token longo (chamado pelo cron antes de vencer)
// Deploy: supabase functions deploy ig-auth --project-ref SEU-PROJETO --use-api --no-verify-jwt
// Secrets: IG_APP_ID, IG_APP_SECRET, IG_APP_URL (front), IG_CRON_SECRET
import { admin, APP_ID, APP_SECRET, APP_URL, CORS, CRON_SECRET, graph, graphPost, html, json, log, SCOPES, SUPABASE_URL, tokenDaConta } from "../_shared/ig.ts";

import { hubAssinar, hubChavePublica, hubDoPainel, hubVerificar, nomeDoPainel, painelDoHub } from "../_shared/hub.ts";

const REDIRECT = `${SUPABASE_URL}/functions/v1/ig-auth/callback`;
const CAMPOS_WEBHOOK = "comments,messages,message_reactions,messaging_postbacks,messaging_seen";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.split("/ig-auth")[1] || "/";

  if (rota === "/start") {
    const quem = url.searchParams.get("u") || "";
    // Painel sem a chave secreta do aplicativo: quem conclui o login do Instagram é o hub (o projeto que guarda a chave).
    if (!APP_SECRET) {
      const [hub, nome] = await Promise.all([hubDoPainel(), nomeDoPainel()]);
      if (hub && nome) return Response.redirect(`${hub}/ig-auth/start?painel=${encodeURIComponent(nome)}&u=${encodeURIComponent(quem)}`, 302);
    }
    if (!APP_ID) return html(pagina("Falta configurar IG_APP_ID e IG_APP_SECRET nos secrets do Supabase."), 500);
    // Pedido de outro painel (só os listados em IG_PAINEIS): o nome dele viaja no state e volta no callback.
    const painel = url.searchParams.get("painel") || "";
    if (painel && !painelDoHub(painel)) return html(pagina("Painel desconhecido: " + painel), 400);
    const state = painel ? `p:${painel}|${quem}` : quem;
    const auth = new URL("https://www.instagram.com/oauth/authorize");
    auth.searchParams.set("client_id", APP_ID);
    auth.searchParams.set("redirect_uri", REDIRECT);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", SCOPES);
    auth.searchParams.set("state", state);
    auth.searchParams.set("enable_fb_login", "0");
    auth.searchParams.set("force_authentication", "1");
    return Response.redirect(auth.toString(), 302);
  }

  if (rota === "/callback") {
    const code = url.searchParams.get("code");
    const erro = url.searchParams.get("error_description") || url.searchParams.get("error");
    // Erro na conexão: volta para o app que pediu (o deste projeto ou o do painel atendido pelo hub) com a mensagem na tela.
    // (O Supabase entrega página HTML das funções como texto puro, então a página de erro aparecia como código.)
    const voltar = (msg: string, status = 500) => {
      const pp = (url.searchParams.get("state") || "").match(/^p:([A-Za-z0-9_-]+)\|/);
      const base = pp ? painelDoHub(pp[1])?.app : APP_URL;
      return base ? Response.redirect(`${base}/?erro_conexao=${encodeURIComponent(msg)}#contas`, 302) : html(pagina(msg), status);
    };
    const amigavel = (e: unknown) => /Unsupported request - method type|does not exist, cannot be loaded|missing permissions/i.test(String(e))
      ? "O Instagram autorizou, mas esta conta ainda não pode usar o aplicativo. Aceite o convite em Instagram › Configurações › Apps e sites › Convites do testador e conecte de novo."
      : "Não consegui concluir a conexão com o Instagram: " + String(e).replace(/^Error:\s*/, "").slice(0, 220);
    if (erro || !code) return voltar(`O Instagram não autorizou a conexão${erro ? ": " + erro : ""}.`, 400);
    try {
      // 1) token curto
      const form = new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, grant_type: "authorization_code", redirect_uri: REDIRECT, code: code.replace(/#_$/, "") });
      const r1 = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
      const j1 = await r1.json();
      if (!r1.ok || !j1.access_token) throw new Error(`token curto: ${JSON.stringify(j1)}`);
      // 2) token longo (60 dias)
      const r2 = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${APP_SECRET}&access_token=${j1.access_token}`);
      const j2 = await r2.json();
      const token = j2.access_token || j1.access_token;
      const expira = new Date(Date.now() + (j2.expires_in || 3600) * 1000).toISOString();
      // 3) perfil
      await log("auth", null, { etapa: "tokens", user_id: j1.user_id, permissoes: j1.permissions, longo: !!j2.access_token, erro_longo: j2.error?.message || null });
      const campos = "user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography";
      let me: Record<string, unknown>;
      try { me = await graph("me", token, { fields: campos }); }
      catch (e1) {
        await log("erro", null, { onde: "me", erro: String(e1) });
        try { me = await graph(String(j1.user_id), token, { fields: campos }); }
        catch (e2) {
          if ((url.searchParams.get("state") || "").startsWith("p:")) throw e2; // conta de outro painel: nada dela fica guardado aqui
          // guarda o token mesmo assim para diagnóstico (conta fica marcada como pendente)
          const pid = String(j1.user_id);
          await admin().from("ig_contas").upsert({ id: pid, username: "pendente_" + pid, ativo: false, token_expira: expira, erro_sync: String(e2).slice(0, 300) });
          await admin().from("ig_tokens").upsert({ conta_id: pid, access_token: token, expira_em: expira, permissoes: (j1.permissions || []) as string[] });
          throw e2;
        }
      }
      const id = String(me.user_id || me.id || j1.user_id);
      // Login feito a pedido de outro painel: a conta e o token seguem assinados para lá e NÃO são guardados neste projeto.
      const paraPainel = (url.searchParams.get("state") || "").match(/^p:([A-Za-z0-9_-]+)\|(.*)$/);
      if (paraPainel) {
        const destino = painelDoHub(paraPainel[1]);
        if (!destino) throw new Error("painel desconhecido: " + paraPainel[1]);
        let webhook_ok = false;
        try { await graphPost(`${id}/subscribed_apps`, token, { subscribed_fields: CAMPOS_WEBHOOK }); webhook_ok = true; }
        catch (e) { await log("erro", null, { onde: "subscribed_apps (painel " + paraPainel[1] + ")", erro: String(e).slice(0, 200) }); }
        const corpo = JSON.stringify({ ts: Date.now(), quem: paraPainel[2], token, expira, permissoes: j1.permissions || [], webhook_ok,
          conta: { id, username: me.username, nome: me.name, foto: me.profile_picture_url, biografia: me.biography, seguidores: me.followers_count, seguindo: me.follows_count, midias: me.media_count } });
        const r = await fetch(destino.adotar, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-assinatura": await hubAssinar(corpo) }, body: corpo });
        if (!r.ok) throw new Error(`o painel ${paraPainel[1]} não aceitou a conta (${r.status}): ${(await r.text()).slice(0, 200)}`);
        await log("auth", null, { painel: paraPainel[1], username: me.username, webhook_ok });
        return Response.redirect(`${destino.app}/?conectado=${encodeURIComponent(String(me.username))}`, 302);
      }
      const db = admin();
      await db.from("ig_contas").upsert({
        id, username: me.username, nome: me.name, foto: me.profile_picture_url, biografia: me.biography,
        seguidores: me.followers_count, seguindo: me.follows_count, midias: me.media_count,
        ativo: true, conectado_em: new Date().toISOString(), token_expira: expira, erro_sync: null,
      });
      await db.from("ig_tokens").upsert({ conta_id: id, access_token: token, expira_em: expira, permissoes: (j1.permissions || []) as string[], atualizado_em: new Date().toISOString() });
      // conta que acabou de entrar: começa no modo Conteúdo (agenda, direct, comentários, automações), sem rotina de vendas
      const { data: cz } = await db.from("ig_contas").select("config").eq("id", id).maybeSingle();
      if (!cz?.config || !Object.keys(cz.config as Record<string, unknown>).length) await db.from("ig_contas").update({ config: { perfil: "conteudo", auto: false, modo: "aprovacao", sem_story_captura: true } }).eq("id", id);
      // quem conectou tem acesso só a algumas contas (cliente): a conta nova entra na lista dele
      const quemConectou = (url.searchParams.get("state") || "").trim().toLowerCase();
      if (quemConectou) {
        const { data: ac } = await db.from("ig_acesso").select("email,contas").ilike("email", quemConectou).maybeSingle();
        if (ac && Array.isArray(ac.contas) && !ac.contas.includes(id)) await db.from("ig_acesso").update({ contas: [...ac.contas, id] }).eq("email", ac.email);
      }
      // 4) assina webhooks de comentários e mensagens
      let webhook_ok = false;
      try {
        await graphPost(`${id}/subscribed_apps`, token, { subscribed_fields: CAMPOS_WEBHOOK });
        webhook_ok = true;
      } catch (e) { await log("erro", id, { onde: "subscribed_apps", erro: String(e) }); }
      await db.from("ig_contas").update({ webhook_ok }).eq("id", id);
      await log("auth", id, { username: me.username, expira, webhook_ok });
      // 5) dispara o primeiro sync em segundo plano
      fetch(`${SUPABASE_URL}/functions/v1/ig-api/sync`, { method: "POST", headers: { "x-cron": CRON_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ conta_id: id, completo: true }) }).catch(() => {});
      return Response.redirect(`${APP_URL}/?conectado=${encodeURIComponent(me.username)}`, 302);
    } catch (e) {
      await log("erro", null, { onde: "callback", erro: String(e) });
      return voltar(amigavel(e));
    }
  }

  // ---------- hub: chave pública e teste do caminho até um painel ----------
  if (rota === "/chave") return json(await hubChavePublica()); // chave pública deste projeto (hub ou painel)
  if (rota === "/hub-teste" && req.method === "POST") {
    if (!CRON_SECRET || req.headers.get("x-cron") !== CRON_SECRET) return json({ erro: "não autorizado" }, 401);
    const { painel } = await req.json().catch(() => ({}));
    const destino = painelDoHub(String(painel || ""));
    if (!destino) return json({ erro: "painel desconhecido" }, 400);
    const corpo = JSON.stringify({ ts: Date.now(), ping: true });
    const r = await fetch(destino.adotar, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-assinatura": await hubAssinar(corpo) }, body: corpo });
    return json({ status: r.status, resposta: (await r.text()).slice(0, 200) });
  }

  // ---------- painel: recebe do hub a conta que acabou de autorizar (assinada pelo hub) ----------
  if (rota === "/adotar" && req.method === "POST") {
    const raw = await req.text();
    if (!(await hubVerificar(raw, req.headers.get("x-hub-assinatura")))) return json({ erro: "assinatura inválida" }, 403);
    const b = JSON.parse(raw);
    if (Math.abs(Date.now() - Number(b.ts)) > 5 * 60000) return json({ erro: "pedido vencido" }, 403);
    if (b.ping) return json({ ok: true, ping: true });
    const c = b.conta || {};
    const id = String(c.id || "");
    if (!id || !b.token) return json({ erro: "conta ou token ausente" }, 400);
    const db = admin();
    await db.from("ig_contas").upsert({
      id, username: c.username, nome: c.nome, foto: c.foto, biografia: c.biografia, seguidores: c.seguidores, seguindo: c.seguindo, midias: c.midias,
      ativo: true, conectado_em: new Date().toISOString(), token_expira: b.expira, erro_sync: null, webhook_ok: !!b.webhook_ok,
    });
    await db.from("ig_tokens").upsert({ conta_id: id, access_token: b.token, expira_em: b.expira, permissoes: (b.permissoes || []) as string[], atualizado_em: new Date().toISOString() });
    const { data: cz } = await db.from("ig_contas").select("config").eq("id", id).maybeSingle();
    if (!cz?.config || !Object.keys(cz.config as Record<string, unknown>).length) await db.from("ig_contas").update({ config: { perfil: "conteudo", auto: false, modo: "aprovacao", sem_story_captura: true } }).eq("id", id);
    const quem = String(b.quem || "").trim().toLowerCase();
    if (quem) {
      const { data: ac } = await db.from("ig_acesso").select("email,contas").ilike("email", quem).maybeSingle();
      if (ac && Array.isArray(ac.contas) && !ac.contas.includes(id)) await db.from("ig_acesso").update({ contas: [...ac.contas, id] }).eq("email", ac.email);
    }
    await log("auth", id, { username: c.username, expira: b.expira, webhook_ok: !!b.webhook_ok, via: "hub" });
    fetch(`${SUPABASE_URL}/functions/v1/ig-api/sync`, { method: "POST", headers: { "x-cron": CRON_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ conta_id: id, completo: true }) }).catch(() => {});
    return json({ ok: true });
  }

  if (rota === "/refresh" && req.method === "POST") {
    if (req.headers.get("x-cron") !== CRON_SECRET) return json({ erro: "não autorizado" }, 401);
    const { conta_id } = await req.json().catch(() => ({}));
    const db = admin();
    const contas = conta_id ? [conta_id] : (await db.from("ig_contas").select("id").eq("ativo", true)).data?.map((c) => c.id) || [];
    const out: Record<string, string> = {};
    for (const id of contas) {
      try {
        const tok = await tokenDaConta(id);
        if (!tok) { out[id] = "sem token"; continue; }
        const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${tok}`);
        const j = await r.json();
        if (!j.access_token) throw new Error(JSON.stringify(j));
        const expira = new Date(Date.now() + (j.expires_in || 5184000) * 1000).toISOString();
        await db.from("ig_tokens").update({ access_token: j.access_token, expira_em: expira, atualizado_em: new Date().toISOString() }).eq("conta_id", id);
        await db.from("ig_contas").update({ token_expira: expira }).eq("id", id);
        out[id] = "ok até " + expira.slice(0, 10);
      } catch (e) { out[id] = String(e); await log("erro", id, { onde: "refresh", erro: String(e) }); }
    }
    return json(out);
  }

  return json({ ok: true, rotas: ["/start?u=email", "/callback", "POST /refresh"], redirect_uri: REDIRECT });
});

function pagina(msg: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,system-ui;background:#050604;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:420px;padding:32px;text-align:center"><div style="font-size:40px">⚠️</div><h2 style="margin:12px 0">AI Runner Social Media</h2><p style="opacity:.85;line-height:1.5">${msg}</p><a href="${APP_URL}" style="color:#C8F000">Voltar ao app</a></div></body>`;
}
