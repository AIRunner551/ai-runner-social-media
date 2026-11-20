// TikTok for Developers (Login Kit + Content Posting API). Usado por tiktok-auth e ig-api.
// Secrets: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET. Tokens em tk_tokens (1 TikTok por conta do Instagram).
import { admin, SUPABASE_URL } from "./ig.ts";

export const TK_KEY = Deno.env.get("TIKTOK_CLIENT_KEY") || "";
export const TK_SECRET = Deno.env.get("TIKTOK_CLIENT_SECRET") || "";
export const TK_REDIRECT = `${SUPABASE_URL}/functions/v1/tiktok-auth/callback`;
export const TK_SCOPES = "user.info.basic,video.upload,video.publish";
const API = "https://open.tiktokapis.com";

type Row = Record<string, unknown>;

export async function tkTokenRequest(params: Record<string, string>): Promise<Row> {
  const r = await fetch(`${API}/v2/oauth/token/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_key: TK_KEY, client_secret: TK_SECRET, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`TikTok token: ${j.error_description || j.error || r.status}`);
  return j;
}

export async function tkSalvarToken(conta_id: string, j: Row, extra: Row = {}) {
  const agora = Date.now();
  await admin().from("tk_tokens").upsert({
    conta_id, open_id: j.open_id, access_token: j.access_token, refresh_token: j.refresh_token, scope: j.scope,
    expira_em: new Date(agora + Number(j.expires_in || 86400) * 1000).toISOString(),
    refresh_expira_em: new Date(agora + Number(j.refresh_expires_in || 31536000) * 1000).toISOString(),
    atualizado_em: new Date().toISOString(), ...extra,
  });
}

// token válido da conta (renova sozinho quando faltam menos de 15 min); null se a conta não tem TikTok conectado
export async function tkToken(conta_id: string): Promise<string | null> {
  const { data: t } = await admin().from("tk_tokens").select("*").eq("conta_id", conta_id).maybeSingle();
  if (!t) return null;
  if (new Date(t.expira_em).getTime() - Date.now() > 15 * 60000) return t.access_token;
  const j = await tkTokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
  await tkSalvarToken(conta_id, j);
  return String(j.access_token);
}

export async function tkGet(path: string, token: string): Promise<Row> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.error && j.error.code && j.error.code !== "ok")) throw new Error(`TikTok ${path.split("?")[0]}: ${j.error?.message || j.error?.code || r.status}`);
  return (j.data || {}) as Row;
}
export async function tkPost(path: string, token: string, body: Row): Promise<Row> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.error && j.error.code && j.error.code !== "ok")) throw new Error(`TikTok ${path}: ${j.error?.message || j.error?.code || r.status}`);
  return (j.data || {}) as Row;
}

// Dados atuais do criador (apelido, opções de privacidade, interações desativadas, duração máxima).
// As diretrizes do TikTok exigem consultar isto toda vez que a tela de publicação é aberta e antes de publicar.
export async function tkCriador(token: string): Promise<Row> {
  return await tkPost("/v2/post/publish/creator_info/query/", token, {});
}

export type TkOpcoes = { modo?: string; titulo?: string; privacidade?: string; comentario?: boolean; dueto?: boolean; stitch?: boolean; comercial?: boolean; sua_marca?: boolean; conteudo_marca?: boolean };

// Envia um vídeo (URL pública em domínio verificado no portal).
// modo "rascunho": cai na caixa de entrada do TikTok e a pessoa finaliza no app.
// modo "direto": publica no perfil com EXATAMENTE o que a pessoa escolheu na tela (privacidade, interações, divulgação
// comercial). Nunca escolhe privacidade por conta própria: sem escolha válida, recusa.
export async function tkEnviarVideo(token: string, video_url: string, o: TkOpcoes): Promise<{ publish_id: string; privacidade?: string }> {
  if (o.modo !== "direto") {
    const d = await tkPost("/v2/post/publish/inbox/video/init/", token, { source_info: { source: "PULL_FROM_URL", video_url } });
    return { publish_id: String(d.publish_id) };
  }
  const info = await tkCriador(token);
  const opcoes = (info.privacy_level_options as string[]) || [];
  if (!o.privacidade) throw new Error("Escolha quem pode ver o vídeo no TikTok antes de publicar.");
  if (!opcoes.includes(o.privacidade)) throw new Error("A privacidade escolhida não está disponível para esta conta do TikTok agora. Abra o post e escolha de novo.");
  if (o.comercial && !o.sua_marca && !o.conteudo_marca) throw new Error("Indique se o conteúdo promove a sua marca, um terceiro ou os dois.");
  if (o.conteudo_marca && o.privacidade === "SELF_ONLY") throw new Error("Conteúdo de marca não pode ser publicado como privado.");
  const d = await tkPost("/v2/post/publish/video/init/", token, {
    post_info: {
      title: String(o.titulo || "").slice(0, 2200), privacy_level: o.privacidade,
      disable_comment: !o.comentario || !!info.comment_disabled, disable_duet: !o.dueto || !!info.duet_disabled, disable_stitch: !o.stitch || !!info.stitch_disabled,
      brand_organic_toggle: !!(o.comercial && o.sua_marca), brand_content_toggle: !!(o.comercial && o.conteudo_marca),
    },
    source_info: { source: "PULL_FROM_URL", video_url },
  });
  return { publish_id: String(d.publish_id), privacidade: o.privacidade };
}
export async function tkStatus(token: string, publish_id: string): Promise<Row> {
  return await tkPost("/v2/post/publish/status/fetch/", token, { publish_id });
}
