// AI Runner Social Media: helpers compartilhados pelas Edge Functions ig-auth, ig-webhook e ig-api.
// API usada: "Instagram API with Instagram Login" (graph.instagram.com). Não precisa de Página do Facebook.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const GRAPH = "https://graph.instagram.com/v26.0";
export const APP_ID = Deno.env.get("IG_APP_ID") || "";
export const APP_SECRET = Deno.env.get("IG_APP_SECRET") || "";
export const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") || "";
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
// Chaves do projeto: os nomes antigos ainda existem nas funções; se saírem de linha, valem os dicionários novos do Supabase.
function primeiraChave(nome: string): string {
  try {
    const j = JSON.parse(Deno.env.get(nome) || "{}");
    const v = j && typeof j === "object" ? (j.default ?? Object.values(j)[0]) : j;
    return typeof v === "string" ? v : String((v as { api_key?: string })?.api_key || "");
  } catch { return ""; }
}
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || primeiraChave("SUPABASE_SECRET_KEYS");
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || primeiraChave("SUPABASE_PUBLISHABLE_KEYS");

// Segredos internos (rotinas agendadas e verificação do webhook): se existirem nos Secrets das funções, valem eles;
// senão vêm da tabela ig_interno, onde o banco gera os valores sozinho na instalação. Ninguém precisa inventar nem copiar segredo.
async function interno(chave: string): Promise<string> {
  try {
    const { data } = await createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } }).from("ig_interno").select("valor").eq("chave", chave).maybeSingle();
    return String(data?.valor || "");
  } catch { return ""; }
}
export const CRON_SECRET = Deno.env.get("IG_CRON_SECRET") || await interno("cron");
export const VERIFY_TOKEN = Deno.env.get("IG_WEBHOOK_VERIFY") || await interno("webhook");
export const APP_URL = Deno.env.get("IG_APP_URL") || "";

export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
].join(",");

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
}

export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// Valida o JWT do usuário logado no app e confere a lista de acesso.
export async function usuarioAutorizado(req: Request): Promise<{ email: string; id: string; contas: string[] | null } | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user?.email) return null;
  // Quem entra: e-mail liberado em ig_acesso. contas: null = todas (admin ou equipe da casa); lista = só aquelas contas (cliente)
  const { data: acesso } = await admin().from("ig_acesso").select("email,papel,contas").ilike("email", user.email).maybeSingle();
  if (!acesso) return null;
  return { email: user.email, id: user.id, contas: acesso.papel === "admin" ? null : (Array.isArray(acesso.contas) ? (acesso.contas as string[]) : null) };
}
export const podeConta = (user: { contas?: string[] | null }, conta_id: string) => !user.contas || user.contas.includes(conta_id);

// o Instagram às vezes entrega só o número da pessoa: isso não é um @
export const semArroba = (u: string) => /^\d{9,}$/.test(String(u || ""));

// perfis que nunca viram lead nesta conta (sócios, equipe, a própria empresa): config.ignorar da conta
export async function ehDaCasa(conta_id: string, username: string): Promise<boolean> {
  const u = String(username || "").replace(/^@/, "").trim().toLowerCase();
  if (!u || !conta_id) return false;
  const { data } = await admin().from("ig_contas").select("config").eq("id", conta_id).maybeSingle();
  const lista = ((data?.config || {}) as Record<string, unknown>).ignorar;
  return Array.isArray(lista) && lista.map((x) => String(x).replace(/^@/, "").trim().toLowerCase()).includes(u);
}

export async function log(tipo: string, conta_id: string | null, detalhe: unknown) {
  try { await admin().from("ig_log").insert({ tipo, conta_id, detalhe }); } catch { /* nunca derruba */ }
}

export async function tokenDaConta(conta_id: string): Promise<string | null> {
  const { data } = await admin().from("ig_tokens").select("access_token").eq("conta_id", conta_id).maybeSingle();
  return data?.access_token || null;
}

// Chamada à Graph API com tratamento de erro padronizado.
export async function graph(path: string, token: string, params: Record<string, string> = {}, init: RequestInit = {}) {
  const url = new URL(path.startsWith("http") ? path : `${GRAPH}/${path.replace(/^\//, "")}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("access_token", token);
  const r = await fetch(url.toString(), init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) {
    const e = body.error || {};
    throw new Error(`graph ${path}: ${e.message || r.status} (code ${e.code || "-"}${e.error_subcode ? "/" + e.error_subcode : ""})`);
  }
  return body;
}

export async function graphPost(path: string, token: string, body: Record<string, unknown>) {
  const url = `${GRAPH}/${path.replace(/^\//, "")}?access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`graph POST ${path}: ${j.error?.message || r.status} (code ${j.error?.code || "-"})`);
  return j;
}

// Gemini (mesma chave do leitor de notas do Flow)
export async function gemini(prompt: string, opts: { json?: boolean; modelo?: string; temp?: number } = {}): Promise<string> {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY não configurada");
  const modelo = opts.modelo || Deno.env.get("GEMINI_MODEL") || "gemini-3-flash-preview";
  const call = async (m: string) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: opts.temp ?? 0.7, ...(opts.json ? { responseMimeType: "application/json" } : {}) },
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`gemini ${m}: ${j.error?.message || r.status}`);
    return (j.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  };
  try { return await call(modelo); } catch (e) {
    if (String(e).includes("404")) return await call("gemini-2.5-flash");
    throw e;
  }
}

export const hoje = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
export const agoraBR = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
export const saudacao = () => { const h = agoraBR().getHours(); return h < 12 ? "bom dia" : h < 18 ? "boa tarde" : "boa noite"; };

// Gemini às vezes devolve texto antes/depois do JSON ou cercas ```json: extrai o primeiro objeto válido
export function parseJSON(txt: string): Record<string, unknown> {
  const s = String(txt || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(s); } catch { /* tenta recortar */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* cai no erro abaixo */ } }
  throw new Error("resposta da IA não veio em JSON: " + s.slice(0, 120));
}
