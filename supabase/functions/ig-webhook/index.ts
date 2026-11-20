// Edge Function: ig-webhook
// Recebe os webhooks do Instagram (objeto "instagram"): comentários novos e mensagens do direct.
//   GET  -> verificação (hub.challenge) com IG_WEBHOOK_VERIFY
//   POST -> grava comentário/mensagem, abre lead quando faz sentido e cria a ação na fila do dia.
// Deploy: supabase functions deploy ig-webhook --project-ref SEU-PROJETO --use-api --no-verify-jwt
// Na Meta: Callback URL = https://SEU-PROJETO.supabase.co/functions/v1/ig-webhook ; campos: comments, messages
import { admin, APP_SECRET, CORS, CRON_SECRET, ehDaCasa, graph, graphPost, hoje, json, log, semArroba, SUPABASE_URL, tokenDaConta, VERIFY_TOKEN } from "../_shared/ig.ts";

// pede à ig-api para pesquisar/triar o lead e colocá-lo no fluxo (sem esperar a resposta)
function pesquisarAsync(conta_id: string, username: string, fluxo: string, sinal: string) {
  fetch(`${SUPABASE_URL}/functions/v1/ig-api/lead/pesquisar`, { method: "POST", headers: { "x-cron": CRON_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ conta_id, username, fluxo, sinal }) }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("verify_token inválido", { status: 403 });
  }

  const raw = await req.text();
  // assinatura (quando a Meta manda)
  const sig = req.headers.get("x-hub-signature-256");
  // a Meta assina os eventos; chamada interna de teste usa x-cron. Evento sem assinatura não dispara automação (evita webhook forjado).
  const interno = !!CRON_SECRET && req.headers.get("x-cron") === CRON_SECRET;
  const confiavel = (!!sig && !!APP_SECRET) || interno; // só vale assinatura que dá para conferir; sem isso o evento é gravado, mas não dispara automação
  const seco = interno && req.headers.get("x-seco") === "1"; // teste interno: acha a regra e registra, sem enviar
  if (sig && APP_SECRET) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (`sha256=${hex}` !== sig) { await log("erro", null, { onde: "webhook", erro: "assinatura inválida" }); return new Response("bad sig", { status: 403 }); }
  }

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw); } catch { return json({ ok: false }, 400); }
  // Um mesmo aplicativo da Meta pode servir a mais de um painel, mas só tem UM endereço de webhook. Evento de conta que não é
  // deste painel não é gravado aqui: é repassado inteiro (com a assinatura original) para os endereços em IG_WEBHOOK_REPASSE.
  const idsEvento = ((body.entry as Array<Record<string, unknown>>) || []).map((e) => String(e.id));
  const { data: minhas } = idsEvento.length ? await admin().from("ig_contas").select("id").in("id", idsEvento) : { data: [] };
  const conhecidas = new Set((minhas || []).map((c) => String(c.id)));
  const estranhas = idsEvento.filter((i) => !conhecidas.has(i));
  if (estranhas.length && sig) {
    for (const destino of (Deno.env.get("IG_WEBHOOK_REPASSE") || "").split(",").map((x) => x.trim()).filter(Boolean)) {
      try { await fetch(destino, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": sig }, body: raw, signal: AbortSignal.timeout(8000) }); }
      catch (e) { await log("erro", null, { onde: "webhook.repasse", destino, erro: String(e).slice(0, 200) }); }
    }
  }
  if (!conhecidas.size) return json({ ok: true, repassado: estranhas.length });
  await log("webhook", null, body);

  // responde rápido e processa; a Meta reenvia se não receber 200 em alguns segundos
  try { await processar(body, confiavel, seco); } catch (e) { await log("erro", null, { onde: "webhook.processar", erro: String(e) }); }
  return json({ ok: true });
});

async function processar(body: Record<string, unknown>, confiavel = false, seco = false) {
  if (body.object !== "instagram") return;
  const db = admin();
  for (const entry of (body.entry as Array<Record<string, unknown>>) || []) {
    const conta_id = String(entry.id);
    // conta só de conteúdo (config.perfil = "conteudo"): guarda comentários e mensagens, mas não abre lead nem tarefa de social selling
    const { data: ctaCfg } = await db.from("ig_contas").select("config").eq("id", conta_id).maybeSingle();
    if (!ctaCfg) continue; // conta de outro painel (o evento já foi repassado)
    const soConteudo = ((ctaCfg?.config || {}) as Record<string, unknown>).perfil === "conteudo";
    // --- comentários ---
    for (const ch of (entry.changes as Array<{ field: string; value: Record<string, unknown> }>) || []) {
      if (ch.field !== "comments") continue;
      const v = ch.value as { id: string; text?: string; from?: { id: string; username: string }; media?: { id: string }; parent_id?: string };
      const de_mim = v.from?.id === conta_id;
      const { error } = await db.from("ig_comentarios").upsert({
        id: v.id, conta_id, midia_id: v.media?.id, parent_id: v.parent_id || null,
        autor_id: v.from?.id, autor_username: v.from?.username, texto: v.text || "",
        criado_em: new Date().toISOString(), de_mim, lido: de_mim,
      }, { onConflict: "id", ignoreDuplicates: false });
      if (error) throw error;
      if (de_mim) continue;
      // post novo que ainda não está na biblioteca? busca na hora, para o comentário aparecer com capa e link
      if (v.media?.id) {
        const { data: mExiste } = await db.from("ig_midias").select("id").eq("id", v.media.id).maybeSingle();
        if (!mExiste) {
          try {
            const tok = await tokenDaConta(conta_id);
            if (tok) {
              const m = await graph(v.media.id, tok, { fields: "id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count" });
              await db.from("ig_midias").upsert({ id: m.id, conta_id, tipo: m.media_type, produto: m.media_product_type, legenda: m.caption || "", url: m.media_url, thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : null), permalink: m.permalink, publicado_em: m.timestamp, curtidas: m.like_count ?? 0, comentarios: m.comments_count ?? 0 });
            }
          } catch (e) { await log("erro", conta_id, { onde: "midia do comentário", erro: String(e).slice(0, 200) }); }
        }
      }
      // conta o comentário na mídia
      await db.rpc("ig_inc_comentarios", { p_midia: v.media?.id }).then(() => {}, () => {});
      // automação de comentário (palavra-chave → direct com o link + resposta pública); vale para qualquer modo de conta
      let automatizou = false;
      try { if (confiavel && !v.parent_id) automatizou = await automacaoDeComentario(conta_id, v); } catch (e) { await log("erro", conta_id, { onde: "automacao", comentario: v.id, erro: String(e).slice(0, 200) }); }
      if (automatizou) {
        // em conta de vendas quem pediu o link vira lead quente, mas sem tarefa duplicada de responder o comentário
        if (!soConteudo) { const ld = await garantirLead(conta_id, v.from?.username || "", v.from?.id, "CP", `pediu o link no post: "${(v.text || "").slice(0, 60)}"`); if (ld?.id) await db.from("ig_comentarios").update({ lead_id: ld.id }).eq("id", v.id); }
        continue;
      }
      if (soConteudo) continue;
      // fluxo CP: lead com o comentário (para a resposta privada pela API) + entra no fluxo configurado
      const lead = await garantirLead(conta_id, v.from?.username || "", v.from?.id, "CP", `comentou: "${(v.text || "").slice(0, 80)}"`);
      if (lead?.id) {
        await db.from("ig_leads").update({ comentario_id: v.id }).eq("id", lead.id);
        await db.from("ig_comentarios").update({ lead_id: lead.id }).eq("id", v.id);
        if (lead.etapa === "novo" || lead.etapa === "frio") pesquisarAsync(conta_id, v.from?.username || "", "CP", `comentou: "${(v.text || "").slice(0, 80)}"`);
        else await db.from("ig_acoes").insert({ conta_id, lead_id: lead.id, comentario_id: v.id, data: hoje(), bloco: 2, tipo: "responder_comentario", titulo: `Responder @${v.from?.username} no post`, texto: v.text || "", origem: "webhook:comments", url: `https://www.instagram.com/${v.from?.username}/` });
      }
    }
    // --- mensagens ---
    for (const m of (entry.messaging as Array<Record<string, unknown>>) || []) {
      const sender = (m.sender as { id: string })?.id;
      const recipient = (m.recipient as { id: string })?.id;
      const msg = m.message as { mid: string; text?: string; attachments?: unknown[]; is_echo?: boolean; reply_to?: { story?: { url: string; id: string } } } | undefined;
      const reaction = m.reaction as { mid: string; action: string; emoji?: string; reaction?: string } | undefined;
      // aviso de leitura (a pessoa só visualizou), postback e afins não são mensagem: antes viravam um balão de não lida vazio
      if (!msg && !reaction) continue;
      const ts = new Date(Number(m.timestamp) || Date.now()).toISOString();
      const de_mim = !!msg?.is_echo || sender === conta_id;
      const outro = de_mim ? recipient : sender;
      if (!outro) continue;
      const conversa_id = `ig:${conta_id}:${outro}`;
      // garante a conversa (busca username pelo IGSID quando não temos)
      const { data: conv } = await db.from("ig_conversas").select("id,participante_username,lead_id,nao_lidas").eq("id", conversa_id).maybeSingle();
      let username = conv?.participante_username || "";
      let nome = "", foto = "";
      if (semArroba(username)) username = ""; // número gravado no lugar do @: consulta de novo
      if (!conv || !username) {
        try {
          const tok = await tokenDaConta(conta_id);
          if (tok) { const p = await graph(outro, tok, { fields: "username,name,profile_pic,follower_count,is_user_follow_business,is_business_follow_user" }); username = p.username || username; nome = p.name || ""; foto = p.profile_pic || ""; }
        } catch (e) { await log("erro", conta_id, { onde: "perfil IGSID", erro: String(e) }); }
      }
      let texto = msg?.text || "";
      let tipo = "texto";
      if (reaction) { tipo = "reaction"; texto = reaction.action === "react" ? `reagiu ${reaction.emoji || reaction.reaction || ""} a uma mensagem` : "removeu a reação"; }
      else if (msg?.reply_to?.story) { tipo = "story_reply"; texto = texto || "(respondeu ao story)"; }
      else if ((msg?.attachments || []).some((a: unknown) => (a as { type?: string }).type === "story_mention")) { tipo = "story_mention"; texto = texto || "(te mencionou em um story)"; }
      else if ((msg?.attachments || []).length) { tipo = "anexo"; texto = texto || "(anexo)"; }
      const mid = msg?.mid || reaction?.mid + ":r:" + ts;
      if (!mid) continue;
      await db.from("ig_mensagens").upsert({ id: mid, conversa_id, conta_id, de_mim, texto, tipo, anexos: msg?.attachments || [], criado_em: ts, lido: de_mim });
      // lead: resposta a story = fluxo RS (quente); mensagem espontânea = NS/inbound
      let lead_id = conv?.lead_id || null;
      if (!de_mim && username && !soConteudo) {
        const fluxo = tipo === "story_reply" || tipo === "story_mention" ? "RS" : "NS";
        const lead = await garantirLead(conta_id, username, outro, fluxo, tipo === "story_reply" ? "respondeu story" : "mandou direct");
        lead_id = lead?.id || lead_id;
        if (lead && lead.etapa === "ativado") await db.from("ig_leads").update({ etapa: "rmv", ultimo_toque: ts }).eq("id", lead.id);
        // reação/resposta a story de quem ainda não está em conversa: entra no fluxo RS (1ª mensagem pode sair sozinha)
        if (lead && (tipo === "story_reply" || tipo === "story_mention") && (lead.etapa === "novo" || lead.etapa === "frio")) pesquisarAsync(conta_id, username, "RS", "respondeu story");
      }
      await db.from("ig_conversas").upsert({
        id: conversa_id, conta_id, participante_id: outro,
        participante_username: username || conv?.participante_username || outro,
        ...(nome ? { participante_nome: nome } : {}), ...(foto ? { participante_foto: foto } : {}),
        ultima_msg: texto, ultima_em: ts, ultima_de_mim: de_mim,
        nao_lidas: de_mim ? 0 : (conv?.nao_lidas || 0) + (tipo === "reaction" ? 0 : 1), lead_id, arquivada: false, // curtida numa mensagem não pede resposta
      });
      // automação de direct ("manda OI que eu te envio o link"): só texto ou resposta a story, com evento confiável
      if (!de_mim && confiavel && msg?.text && (tipo === "texto" || tipo === "story_reply")) {
        try { await automacaoDeDirect(conta_id, { mid, texto: msg.text, tipo, outro, username, conversa_id }, seco); }
        catch (e) { await log("erro", conta_id, { onde: "automacao direct", mid, erro: String(e).slice(0, 200) }); }
      }
      if (!de_mim && tipo === "reaction") {
        // curtida numa mensagem: fica no histórico, mas não vira tarefa de responder
      } else if (!de_mim && !soConteudo) {
        // SLA: inbound quente vai pro bloco 2 (responder em até 5 min)
        const { data: ja } = await db.from("ig_acoes").select("id").eq("conversa_id", conversa_id).eq("status", "pendente").eq("tipo", "responder_dm").maybeSingle();
        if (!ja) await db.from("ig_acoes").insert({ conta_id, lead_id, conversa_id, data: hoje(), bloco: 2, tipo: "responder_dm", titulo: `Responder @${username || outro} no direct`, texto, origem: "webhook:messages", url: `https://ig.me/m/${username}` });
      } else {
        // respondemos: marca a ação como feita
        await db.from("ig_acoes").update({ status: "feita", feita_em: ts, feita_por: "instagram" }).eq("conversa_id", conversa_id).eq("status", "pendente").eq("tipo", "responder_dm");
      }
    }
  }
}

// minúsculas, sem acento, só letras e números separados por espaço (com espaço nas pontas, para casar palavra inteira)
const normal = (t: string) => " " + (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " ";

// Automação de comentário: acha a regra ativa da conta que casa com o post e a palavra-chave, manda o direct
// (resposta privada ao comentário, pela API oficial) e responde em público. Uma vez por comentário e, se a regra pedir, por pessoa.
async function automacaoDeComentario(conta_id: string, v: { id: string; text?: string; from?: { id: string; username: string }; media?: { id: string } }): Promise<boolean> {
  const db = admin();
  const { data: regras } = await db.from("ig_automacoes").select("*").eq("conta_id", conta_id).eq("ativo", true).contains("origens", ["comentario"]);
  if (!regras?.length) return false;
  const txt = normal(v.text || "");
  const casa = (r: Record<string, unknown>) => {
    if (r.expira_em && new Date(String(r.expira_em)).getTime() < Date.now()) return false;
    if (r.midia_id && r.midia_id !== v.media?.id) return false;
    if (!r.midia_id && r.planejado_id) return false; // post agendado ainda não publicado
    const ps = ((r.palavras as string[]) || []).map((p) => normal(p)).filter((p) => p.trim());
    return !ps.length || ps.some((p) => txt.includes(p));
  };
  // regra de post específico ganha da regra geral
  const regra = regras.filter(casa).sort((a, b) => (b.midia_id ? 1 : 0) - (a.midia_id ? 1 : 0))[0];
  if (!regra) return false;
  if (regra.uma_vez_por_pessoa && v.from?.id) {
    const { data: ja } = await db.from("ig_automacao_envios").select("id").eq("automacao_id", regra.id).eq("autor_id", v.from.id).eq("dm_ok", true).limit(1);
    if (ja?.length) return false;
  }
  // reserva o comentário (o Instagram reenvia webhooks; a chave única impede envio em dobro)
  const { data: res, error: eRes } = await db.from("ig_automacao_envios").insert({ automacao_id: regra.id, conta_id, comentario_id: v.id, autor_id: v.from?.id, autor_username: v.from?.username, texto_comentario: (v.text || "").slice(0, 300) }).select("id").single();
  if (eRes || !res) return false;
  const tok = await tokenDaConta(conta_id);
  if (!tok) { await db.from("ig_automacao_envios").update({ erro: "conta sem token" }).eq("id", res.id); return false; }
  const troca = (t: string) => t.replace(/\{usuario\}/gi, "@" + (v.from?.username || "")).replace(/\{link\}/gi, String(regra.dm_link || ""));
  let dm = troca(String(regra.dm_texto || "")).trim();
  if (regra.dm_link && !dm.includes(String(regra.dm_link))) dm = (dm + "\n" + regra.dm_link).trim();
  let dm_ok = false, publica_ok = false; const erros: string[] = [];
  if (dm) { try { await graphPost("me/messages", tok, { recipient: { comment_id: v.id }, message: { text: dm } }); dm_ok = true; } catch (e) { erros.push("direct: " + String(e).slice(0, 160)); } }
  const pubs = ((regra.respostas_publicas as string[]) || []).filter((x) => x && x.trim());
  let publica = "";
  if (pubs.length && (dm_ok || !dm)) {
    publica = troca(pubs[Math.floor(Math.random() * pubs.length)]);
    try { const r = await graphPost(`${v.id}/replies`, tok, { message: publica }); publica_ok = true;
      await db.from("ig_comentarios").upsert({ id: r.id, conta_id, midia_id: v.media?.id, parent_id: v.id, autor_id: conta_id, texto: publica, criado_em: new Date().toISOString(), de_mim: true, lido: true, respondido: true });
    } catch (e) { erros.push("público: " + String(e).slice(0, 160)); }
  }
  await db.from("ig_automacao_envios").update({ dm_ok, publica_ok, erro: erros.join(" | ") || null }).eq("id", res.id);
  if (dm_ok || publica_ok) {
    await db.from("ig_comentarios").update({ respondido: true, lido: true, resposta_texto: publica || dm, sugestao_ia: `automação: ${regra.nome}` }).eq("id", v.id);
    await db.from("ig_automacoes").update({ disparos: Number(regra.disparos || 0) + 1, ultimo_em: new Date().toISOString() }).eq("id", regra.id);
    await log("acao", conta_id, { automacao: regra.nome, para: v.from?.username, dm_ok, publica_ok });
  }
  return dm_ok || publica_ok;
}

// Automação de direct: a pessoa manda a palavra-chave no direct (ou respondendo um story) e recebe a mensagem com o link.
// Vale a janela de 24 h do Instagram, que a própria mensagem dela acabou de abrir. Uma vez por mensagem e, se a regra pedir, por pessoa.
async function automacaoDeDirect(conta_id: string, m: { mid: string; texto: string; tipo: string; outro: string; username: string; conversa_id: string }, seco = false): Promise<boolean> {
  const db = admin();
  const { data: regras } = await db.from("ig_automacoes").select("*").eq("conta_id", conta_id).eq("ativo", true).overlaps("origens", ["story", "direct"]);
  if (!regras?.length) return false;
  const txt = normal(m.texto);
  const nPal = txt.trim() ? txt.trim().split(" ").length : 0;
  const agora = Date.now();
  const origem = m.tipo === "story_reply" ? "story" : "direct";
  const casa = (r: Record<string, unknown>) => {
    if (r.expira_em && new Date(String(r.expira_em)).getTime() < agora) return false;
    if (!((r.origens as string[]) || []).includes(origem)) return false; // de onde veio: resposta a story ou mensagem no direct
    if (r.max_palavras && nPal > Number(r.max_palavras)) return false;
    const ps = ((r.palavras as string[]) || []).map((p) => normal(p)).filter((p) => p.trim());
    if (!ps.length) return origem === "story"; // sem palavra-chave só vale para "qualquer resposta a story"; nunca para todo direct
    return ps.some((p) => txt.includes(p));
  };
  // a regra com palavra-chave ganha da regra "qualquer resposta a story"
  const regra = regras.filter(casa).sort((a, b) => (((b.palavras as string[]) || []).length ? 1 : 0) - (((a.palavras as string[]) || []).length ? 1 : 0))[0];
  if (!regra) return false;
  if (regra.uma_vez_por_pessoa) {
    const { data: ja } = await db.from("ig_automacao_envios").select("id").eq("automacao_id", regra.id).eq("autor_id", m.outro).eq("dm_ok", true).limit(1);
    if (ja?.length) return false;
    // quem já recebeu o link à mão nessa conversa não recebe de novo
    if (regra.dm_link) {
      const { data: mao } = await db.from("ig_mensagens").select("id").eq("conversa_id", m.conversa_id).eq("de_mim", true).ilike("texto", `%${String(regra.dm_link).replace(/[%_]/g, "\\$&")}%`).limit(1);
      if (mao?.length) return false;
    }
  }
  const troca = (t: string) => t.replace(/\{usuario\}/gi, "@" + (m.username || "")).replace(/\{link\}/gi, String(regra.dm_link || ""));
  let dm = troca(String(regra.dm_texto || "")).trim();
  if (regra.dm_link && !dm.includes(String(regra.dm_link))) dm = (dm + "\n" + regra.dm_link).trim();
  if (!dm) return false;
  if (seco) { await log("acao", conta_id, { automacao: regra.nome, para: m.username || m.outro, teste_a_seco: true, enviaria: dm }); return true; }
  // reserva a mensagem (o Instagram reenvia webhooks; a chave única impede envio em dobro)
  const { data: res, error: eRes } = await db.from("ig_automacao_envios").insert({ automacao_id: regra.id, conta_id, comentario_id: m.mid, autor_id: m.outro, autor_username: m.username, texto_comentario: m.texto.slice(0, 300), origem }).select("id").single();
  if (eRes || !res) return false;
  const tok = await tokenDaConta(conta_id);
  if (!tok) { await db.from("ig_automacao_envios").update({ erro: "conta sem token" }).eq("id", res.id); return false; }
  let dm_ok = false, erro: string | null = null;
  try { await graphPost("me/messages", tok, { recipient: { id: m.outro }, message: { text: dm } }); dm_ok = true; } catch (e) { erro = "direct: " + String(e).slice(0, 200); }
  await db.from("ig_automacao_envios").update({ dm_ok, publica_ok: false, erro }).eq("id", res.id);
  if (dm_ok) {
    await db.from("ig_automacoes").update({ disparos: Number(regra.disparos || 0) + 1, ultimo_em: new Date().toISOString() }).eq("id", regra.id);
    await log("acao", conta_id, { automacao: regra.nome, para: m.username || m.outro, dm_ok, gatilho: "direct" });
  } else await log("erro", conta_id, { onde: "automacao direct", automacao: regra.nome, para: m.username || m.outro, erro });
  return dm_ok;
}

async function garantirLead(conta_id: string, username: string, ig_user_id: string | undefined, fluxo: string, sinal: string) {
  // sem @ de verdade (só o número) ou perfil da casa (sócios, equipe, a própria empresa): não vira lead
  if (!username || semArroba(username) || await ehDaCasa(conta_id, username)) return null;
  const db = admin();
  const { data: ex } = await db.from("ig_leads").select("id,etapa,fluxo").eq("conta_id", conta_id).eq("username", username).maybeSingle();
  if (ex) {
    const quente = { SC: 1, RS: 2, CP: 3, NS: 4, VS: 5, OB: 6 } as Record<string, number>;
    const upd: Record<string, unknown> = { ultimo_toque: new Date().toISOString(), ...(ig_user_id ? { ig_user_id } : {}) };
    if ((quente[fluxo] || 9) < (quente[ex.fluxo] || 9)) upd.fluxo = fluxo; // sobe o fluxo quando esquenta
    await db.from("ig_leads").update(upd).eq("id", ex.id);
    return ex;
  }
  const { data } = await db.from("ig_leads").insert({ conta_id, username, ig_user_id, fluxo, etapa: "novo", sinal_calor: sinal, criado_por: "webhook" }).select("id,etapa,fluxo").single();
  return data;
}
