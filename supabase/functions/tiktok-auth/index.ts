// Edge Function: tiktok-auth
// Login com TikTok (Login Kit) para ligar um perfil do TikTok a uma conta do AI Runner Social Media.
//   GET  /tiktok-auth/start?conta=<conta_id>&u=<email>  -> tela de autorização do TikTok
//   GET  /tiktok-auth/callback?code=...&state=...       -> troca o code por tokens e grava em tk_tokens
//   POST /tiktok-auth/desconectar {conta_id}            -> apaga o token (precisa de usuário autorizado)
// Deploy: supabase functions deploy tiktok-auth --project-ref SEU-PROJETO --use-api --no-verify-jwt
// Secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, IG_CRON_SECRET (assina o state), IG_APP_URL
import { admin, APP_URL, CORS, CRON_SECRET, html, json, log, usuarioAutorizado } from "../_shared/ig.ts";
import { TK_KEY, TK_REDIRECT, TK_SCOPES, TK_SECRET, tkGet, tkSalvarToken, tkTokenRequest } from "../_shared/tiktok.ts";

async function assinar(txt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CRON_SECRET || "social"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(txt));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const pagina = (msg: string, ok = false) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Runner Social Media · TikTok</title><body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px;color:#17213A"><h2 style="color:${ok ? "#1F8A5B" : "#C2413B"}">${ok ? "TikTok conectado" : "Não foi possível conectar o TikTok"}</h2><p>${msg}</p><p><a href="${APP_URL}/#contas">Voltar ao AI Runner Social Media</a></p></body>`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.split("/tiktok-auth")[1] || "/";

  if (rota === "/start") {
    if (!TK_KEY) return html(pagina("Falta configurar TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET nos secrets do Supabase."), 500);
    const conta = url.searchParams.get("conta") || "";
    if (!/^\d{5,30}$/.test(conta)) return html(pagina("Conta inválida."), 400);
    const corpo = `${conta}.${Date.now()}`;
    const auth = new URL("https://www.tiktok.com/v2/auth/authorize/");
    auth.searchParams.set("client_key", TK_KEY);
    auth.searchParams.set("scope", TK_SCOPES);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("redirect_uri", TK_REDIRECT);
    auth.searchParams.set("state", `${corpo}.${await assinar(corpo)}`);
    return Response.redirect(auth.toString(), 302);
  }

  if (rota === "/callback") {
    const code = url.searchParams.get("code");
    const erro = url.searchParams.get("error_description") || url.searchParams.get("error");
    const [conta, ts, sig] = (url.searchParams.get("state") || "").split(".");
    if (erro || !code) return html(pagina(`O TikTok não autorizou: ${erro || "sem code"}.`), 400);
    if (!conta || !ts || sig !== await assinar(`${conta}.${ts}`) || Date.now() - Number(ts) > 30 * 60000) return html(pagina("Pedido de conexão inválido ou expirado. Clique em Conectar TikTok de novo."), 400);
    try {
      const j = await tkTokenRequest({ grant_type: "authorization_code", code, redirect_uri: TK_REDIRECT });
      let nome = "", avatar = "";
      try { const u = (await tkGet("/v2/user/info/?fields=open_id,display_name,avatar_url", String(j.access_token))).user as Record<string, unknown>; nome = String(u?.display_name || ""); avatar = String(u?.avatar_url || ""); } catch (e) { await log("erro", conta, { onde: "tiktok user/info", erro: String(e).slice(0, 200) }); }
      await tkSalvarToken(conta, j, { nome, avatar, conectado_em: new Date().toISOString() });
      const { data: c } = await admin().from("ig_contas").select("config").eq("id", conta).maybeSingle();
      await admin().from("ig_contas").update({ config: { ...((c?.config as Record<string, unknown>) || {}), tiktok_api: true, tiktok_nome: nome || null } }).eq("id", conta);
      await log("auth", conta, { tiktok: "conectado", nome, scope: j.scope });
      return Response.redirect(`${APP_URL}/?tk=ok#contas`, 302);
    } catch (e) {
      await log("erro", conta, { onde: "tiktok callback", erro: String(e).slice(0, 300) });
      return html(pagina(String(e instanceof Error ? e.message : e)), 500);
    }
  }

  if (rota === "/desconectar" && req.method === "POST") {
    const interno = !!CRON_SECRET && req.headers.get("x-cron") === CRON_SECRET;
    const user = interno ? { email: "cron" } : await usuarioAutorizado(req);
    if (!user) return json({ erro: "não autorizado" }, 401);
    const b = await req.json().catch(() => ({}));
    const conta = String(b.conta_id || "");
    const restrito = (user as { contas?: string[] | null }).contas;
    if (restrito && !restrito.includes(conta)) return json({ erro: "sem acesso a esta conta" }, 403);
    // revoga o acesso no próprio TikTok (não só apaga o token daqui)
    const { data: t } = await admin().from("tk_tokens").select("access_token").eq("conta_id", conta).maybeSingle();
    let revogado = false;
    if (t?.access_token) {
      try { const r = await fetch("https://open.tiktokapis.com/v2/oauth/revoke/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_key: TK_KEY, client_secret: TK_SECRET, token: t.access_token }) }); revogado = r.ok; }
      catch (e) { await log("erro", conta, { onde: "tiktok revoke", erro: String(e).slice(0, 200) }); }
    }
    await admin().from("tk_tokens").delete().eq("conta_id", conta);
    await log("auth", conta, { tiktok: "desconectado", revogado, por: user.email });
    const { data: c } = await admin().from("ig_contas").select("config").eq("id", conta).maybeSingle();
    await admin().from("ig_contas").update({ config: { ...((c?.config as Record<string, unknown>) || {}), tiktok_api: false } }).eq("id", conta);
    return json({ ok: true });
  }
  return json({ ok: true, rotas: ["/start?conta=&u=", "/callback", "POST /desconectar"], redirect_uri: TK_REDIRECT });
});
