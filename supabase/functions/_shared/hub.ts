// Um aplicativo da Meta, vários painéis.
// O projeto que guarda a chave secreta do aplicativo é o "hub": ele conclui o login do Instagram e repassa os eventos,
// assinando tudo com uma chave própria (ECDSA P-256). Os outros painéis NÃO recebem a chave secreta do aplicativo:
// só conferem a assinatura com a chave pública do hub, que é publicada em <hub>/ig-auth/chave.
import { admin } from "./ig.ts";

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const valorInterno = async (chave: string) => String((await admin().from("ig_interno").select("valor").eq("chave", chave).maybeSingle()).data?.valor || "");

// ---------- lado hub ----------
async function parDeChaves(): Promise<{ priv: JsonWebKey; pub: JsonWebKey }> {
  const db = admin();
  const ler = async () => {
    const { data } = await db.from("ig_interno").select("chave,valor").in("chave", ["hub_priv", "hub_pub"]);
    const m = Object.fromEntries((data || []).map((r) => [r.chave, r.valor])) as Record<string, string>;
    return m.hub_priv && m.hub_pub ? { priv: JSON.parse(m.hub_priv) as JsonWebKey, pub: JSON.parse(m.hub_pub) as JsonWebKey } : null;
  };
  const ja = await ler();
  if (ja) return ja;
  // primeira vez: o próprio servidor gera o par de chaves; a privada nunca sai do banco deste projeto
  const k = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey("jwk", k.privateKey), pub = await crypto.subtle.exportKey("jwk", k.publicKey);
  const { error } = await db.from("ig_interno").insert([{ chave: "hub_priv", valor: JSON.stringify(priv) }, { chave: "hub_pub", valor: JSON.stringify(pub) }]);
  const fim = await ler(); // se outra chamada gravou antes, vale o que ficou no banco
  if (!fim) throw new Error("não consegui guardar as chaves do hub" + (error ? ": " + error.message : ""));
  return fim;
}
export async function hubChavePublica(): Promise<JsonWebKey> { return (await parDeChaves()).pub; }
export async function hubAssinar(corpo: string): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", (await parDeChaves()).priv, ALG, false, ["sign"]);
  return b64(await crypto.subtle.sign(SIG, key, new TextEncoder().encode(corpo)));
}
// Painéis atendidos por este hub. Segredo IG_PAINEIS (não é sigiloso, só endereços):
// {"nome": {"adotar": "https://<projeto>.supabase.co/functions/v1/ig-auth/adotar", "app": "https://endereco-do-app"}}
export function painelDoHub(nome: string): { adotar: string; app: string } | null {
  try { const p = JSON.parse(Deno.env.get("IG_PAINEIS") || "{}")[nome]; return p && p.adotar && p.app ? p : null; } catch { return null; }
}
export const ehHub = () => !!Deno.env.get("IG_PAINEIS");

// ---------- lado painel ----------
// ig_interno: 'hub' = endereço das funções do hub (https://<projeto-hub>.supabase.co/functions/v1); 'painel' = o nome deste painel no hub
export const hubDoPainel = async () => (await valorInterno("hub")).replace(/\/$/, "");
export const nomeDoPainel = () => valorInterno("painel");
let pubCache: { hub: string; key: CryptoKey; em: number } | null = null;
export async function hubVerificar(corpo: string, assinatura: string | null): Promise<boolean> {
  if (!assinatura) return false;
  try {
    const hub = await hubDoPainel();
    if (!hub) return false;
    if (!pubCache || pubCache.hub !== hub || Date.now() - pubCache.em > 3600_000) {
      const jwk = await (await fetch(hub + "/ig-auth/chave", { signal: AbortSignal.timeout(8000) })).json();
      pubCache = { hub, key: await crypto.subtle.importKey("jwk", jwk, ALG, false, ["verify"]), em: Date.now() };
    }
    return await crypto.subtle.verify(SIG, pubCache.key, deB64(assinatura), new TextEncoder().encode(corpo));
  } catch { return false; }
}
