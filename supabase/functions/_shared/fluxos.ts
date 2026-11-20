// Fluxos de entrada do social selling, editáveis por conta na tabela ig_fluxos.
// Aqui ficam os padrões (cadência D1 / D2 / D4). Um passo:
//   { id, tipo: 'reciprocidade'|'comentar'|'mensagem'|'story', dia: N (dias depois do passo anterior / da entrada),
//     titulo, texto (com [Nome], [restaurante], [conexao]), ia: true (a IA escreve a partir do texto como guia),
//     automatico: true (envia pela API oficial quando houver canal: resposta privada a comentário ou conversa aberta),
//     condicao: 'sempre' | 'sem_resposta' (só se o lead ainda não respondeu) }
// Cadência: D1 reciprocidade (seguir, curtir 3 fotos, reagir a story) · D2 mensagem de conexão · D4 mensagem de venda.
export type Passo = { id: string; tipo: string; dia: number; titulo: string; texto?: string; ia?: boolean; automatico?: boolean; condicao?: string };
export type Fluxo = { codigo: string; nome: string; descricao: string; ativo: boolean; so_icp: boolean; passos: Passo[] };

const D1 = (id = "d1"): Passo => ({ id, tipo: "reciprocidade", dia: 0, titulo: "D1 · Seguir, curtir 3 fotos e reagir a 1 story", condicao: "sempre" });
const CONEXAO = "Opa [Nome], bom [dia/tarde]! Tudo certo?\nVi que você começou a me acompanhar por aqui e faço questão de dar um oi pessoalmente. Fui conhecer o [restaurante] e [conexao].\n[pergunta factual sobre a operação dele, uma só, fácil de responder]";
const VENDA = "[Nome], deixa eu te falar rapidinho o que eu faço, pra você saber com quem tá falando: eu acompanho donos de restaurante que faturam bem e sobra pouco, olhando CMV, folha, custo fixo e equipe.\nTenho um Diagnóstico Individual Estratégico, 40 minutos por vídeo, sem custo: a gente olha os números do [restaurante] juntos e você sai sabendo quanto vira lucro de verdade e onde estão os 3 maiores vazamentos. Pra usar comigo ou sozinho.\nFaz sentido pra você? Se fizer, me diz um dia que eu te mando o link.";
const D2 = (texto = CONEXAO, titulo = "D2 · Mensagem de conexão"): Passo => ({ id: "d2", tipo: "mensagem", dia: 1, titulo, texto, ia: true, automatico: true, condicao: "sempre" });
const D4: Passo = { id: "d4", tipo: "mensagem", dia: 2, titulo: "D4 · Mensagem de venda (convite ao Diagnóstico)", texto: VENDA, ia: true, automatico: true, condicao: "sem_resposta" };

export const FLUXOS_PADRAO: Fluxo[] = [
  { codigo: "SC", nome: "Story de captura", descricao: "Respondeu enquete, quiz ou caixinha. Já declarou a dor: responde na hora pelo direct; D4 venda se não avançar.", ativo: true, so_icp: false, passos: [
    { id: "sc1", tipo: "mensagem", dia: 0, titulo: "Resposta ao story de captura", ia: true, automatico: true, condicao: "sempre", texto: "[Nome], vi sua resposta ali. E olha, você tá em boa companhia, a maioria respondeu igual.\nFui conhecer o [restaurante] aqui e [conexao].\nTe pergunto: hoje o que mais te atrapalha pra ter esse número na mão? É falta de tempo, falta de organização dos dados, ou nunca alguém te mostrou como montar?" },
    D4 ] },
  { codigo: "RS", nome: "Reação ou resposta em story", descricao: "Levantou a mão sozinho. D1 reciprocidade · D2 conexão · D4 venda.", ativo: true, so_icp: false, passos: [
    D1(), D2("Opa [Nome], bom [dia/tarde]! Valeu pela reação ali. Fui conhecer o [restaurante] e [conexao].\n[pergunta factual sobre a operação dele, uma só, fácil de responder]"), D4 ] },
  { codigo: "CP", nome: "Comentário ou curtida em post", descricao: "Responde em público; depois D1 reciprocidade · D2 conexão · D4 venda.", ativo: true, so_icp: true, passos: [
    { id: "cp0", tipo: "comentar", dia: 0, titulo: "Responder o comentário em público, agregando valor", ia: true, automatico: true, condicao: "sempre", texto: "1 a 2 linhas, nunca 'top!', pode terminar com pergunta curta." },
    D1(), D2("Opa [Nome], bom [dia/tarde]! Vi seu comentário no post e vim dar um oi pessoalmente. Fui conhecer o [restaurante] e [conexao].\n[pergunta factual sobre a operação dele, uma só, fácil de responder]"), D4 ] },
  { codigo: "NS", nome: "Novo seguidor", descricao: "D1 reciprocidade · D2 conexão · D4 venda.", ativo: true, so_icp: true, passos: [ D1(), D2(), D4 ] },
  { codigo: "VS", nome: "Visita sincera na base parada", descricao: "Frios há 60 dias e quem engajou sem abordagem. D1 reciprocidade · D2 conexão · D4 venda.", ativo: true, so_icp: true, passos: [
    D1(), D2("[Nome], vi [gancho novo do perfil] e lembrei de você. [pergunta factual nova]", "D2 · Reativação com gancho novo"), D4 ] },
  { codigo: "OB", nome: "Outbound ativo", descricao: "D1 reciprocidade · D2 conexão · D4 venda.", ativo: true, so_icp: true, passos: [
    D1(), D2("Opa [Nome], bom [dia/tarde]! Tudo certo?\nFui conhecer o [restaurante] e [conexao].\n[pergunta factual sobre a operação dele, uma só, fácil de responder]"), D4 ] },
];

export const TIPO_PARA_ACAO: Record<string, string> = { reciprocidade: "seguir", comentar: "comentar", mensagem: "ativar", story: "reagir_story" };
export const BLOCO_POR_FLUXO: Record<string, number> = { SC: 2, RS: 2, CP: 2, NS: 4, VS: 7, OB: 8 };

// próximo passo de mensagem depois de `toques` mensagens enviadas (null = fluxo encerrado)
export function proximaMensagem(fx: Fluxo, toques: number): Passo | null {
  const msgs = fx.passos.filter((p) => p.tipo === "mensagem");
  return msgs[toques] || null;
}

export function preencher(texto: string, lead: Record<string, unknown>, saud: string): string {
  return (texto || "")
    .replace(/\[Nome\]/g, String(lead.nome || lead.username || ""))
    .replace(/\[restaurante\]/g, String(lead.restaurante || "restaurante"))
    .replace(/\[conexao\]/g, String(lead.conexao || "[conexão específica]"))
    .replace(/\[dia\/tarde\]/g, saud.replace("bom ", "").replace("boa ", ""));
}
export const temPlaceholder = (t: string) => /\[[^\]]+\]/.test(t || "");
