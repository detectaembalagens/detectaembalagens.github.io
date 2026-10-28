// EngRevFacaEmbalagem
// Autor: ProfBru - Bruno Penedo © 2026 - TODOS OS DIREITOS RESERVADOS
// E-mail: profbruanbima@gmail.com
//
// Web Worker do site. Nada sai do navegador — a foto do cliente nunca vai para servidor
// nenhum; os modelos são baixados uma vez e ficam em cache local.
//
// PAPÉIS (mesmo arquivo, ?papel=…):
//   coordenador — dono do LOTE (zip, encaixe, prévias) e da parte NEURAL (ONNX Runtime Web):
//                 ISNet / U²-Netp (fundo), SlimSAM (recorte por clique), Depth Anything V2
//                 (desempate da caixa montada)
//   motor       — só o motor Rust/WASM: analisa UM arquivo por vez e devolve o item exportado;
//                 vários motores em paralelo = um por núcleo livre do celular/notebook
//
// ESCADA DE EXECUÇÃO (escolhida em tempo real, no aparelho de quem acessa):
//   ONNX: WebGPU (GPU do aparelho: Chrome/Edge, Android, Safari 26+)
//         → CPU WASM SIMD com THREADS (precisa de isolamento de origem: coi-serviceworker)
//         → CPU WASM SIMD em 1 thread
//   motor: WASM SIMD128 (vetorização de 128 bits) → WASM básico (navegadores antigos)

import iniciar, { Lote, modelos_json, versao, marcadores_pdf } from './faca_motor.js';

const PAPEL = new URL(self.location.href).searchParams.get('papel') || 'coordenador';
const CACHE = 'detectaembalagens-modelos-v2';

const MODELOS = {
  isnet: { arquivo: 'isnet-general-use.int8.onnx', lado: 1024, media: [0.5, 0.5, 0.5], desvio: [1, 1, 1], rotulo: 'ISNet (int8)' },
  u2netp: { arquivo: 'u2netp.onnx', lado: 320, media: [0.485, 0.456, 0.406], desvio: [0.229, 0.224, 0.225], rotulo: 'U²-Netp' },
};
const SAM = { encoder: 'slimsam_encoder_q.onnx', decoder: 'slimsam_decoder_q.onnx', rotulo: 'SlimSAM' };
const PROFUNDIDADE = { arquivo: 'depth_anything_v2_small_int8.onnx', rotulo: 'Depth Anything V2 Small' };

// detecção de WASM SIMD (módulo mínimo com instrução v128 — técnica do wasm-feature-detect)
const SIMD = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));

let lote = null;
let ort = null;
let provedores = ['wasm'];
let acelerador = '';
const sessoes = {};
const samCache = new Map();

async function garantirMotor() {
  if (!lote) {
    await iniciar(new URL(SIMD ? './faca_motor_simd_bg.wasm' : './faca_motor_bg.wasm', import.meta.url));
    lote = new Lote();
  }
}

function progresso(texto) {
  self.postMessage({ progresso: texto });
}

/** ONNX Runtime: WebGPU se houver GPU utilizável (e o usuário não pediu economia), senão CPU. */
async function carregarOrt(preferirGpu) {
  if (ort) return;
  const nucleos = navigator.hardwareConcurrency || 2;
  let gpu = false;
  if (preferirGpu && 'gpu' in navigator) {
    try {
      gpu = !!(await navigator.gpu.requestAdapter());
    } catch (_) {
      gpu = false;
    }
  }
  ort = gpu ? await import('../ort/ort.webgpu.min.mjs') : await import('../ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = new URL('../ort/', import.meta.url).href;
  // threads só com isolamento de origem (SharedArrayBuffer) — o coi-serviceworker providencia no GitHub Pages
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, nucleos - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  provedores = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  acelerador = gpu ? 'WebGPU (GPU do aparelho)' : `CPU · WASM SIMD · ${threads} thread${threads > 1 ? 's' : ''}`;
}

/** Baixa o modelo uma vez (Cache Storage) — depois funciona offline. */
async function baixarModelo(url, rotulo) {
  let resp = null;
  try {
    const c = await caches.open(CACHE);
    resp = await c.match(url);
    if (!resp) {
      progresso(`baixando ${rotulo} (só na primeira vez)…`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await c.put(url, r.clone());
      resp = r;
    }
  } catch (e) {
    resp = await fetch(url);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function sessao(arquivo, rotulo) {
  if (!sessoes[arquivo]) {
    const bytes = await baixarModelo(new URL(`../modelos/${arquivo}`, import.meta.url).href, rotulo);
    progresso(`preparando ${rotulo} (${acelerador})…`);
    try {
      sessoes[arquivo] = await ort.InferenceSession.create(bytes, { executionProviders: provedores, graphOptimizationLevel: 'all' });
    } catch (e) {
      // GPU recusou o modelo (operador sem suporte, memória): cai para a CPU
      provedores = ['wasm'];
      acelerador = `CPU · WASM SIMD · ${ort.env.wasm.numThreads} thread(s) (GPU recusou o modelo)`;
      sessoes[arquivo] = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    }
  }
  return sessoes[arquivo];
}

async function bitmap(bytes) {
  return createImageBitmap(new Blob([bytes]));
}

function pixels(bmp, w, h) {
  const tela = new OffscreenCanvas(w, h);
  const cx = tela.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, w, h);
  return cx.getImageData(0, 0, w, h).data;
}

/** Máscara do objeto (0/255, tamanho original) — pré/pós-processamento idênticos ao rembg. */
async function mascaraNeural(bytes, chave) {
  const m = MODELOS[chave];
  const bmp = await bitmap(bytes);
  const { width: W, height: H } = bmp;
  const S = m.lado;
  const px = pixels(bmp, S, S);
  let max = 1e-6;
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
  const x = new Float32Array(3 * S * S);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    for (let c = 0; c < 3; c++) x[c * S * S + j] = (px[i + c] / max - m.media[c]) / m.desvio[c];
  }
  const s = await sessao(m.arquivo, m.rotulo);
  progresso(`removendo o fundo com ${m.rotulo} (${acelerador})…`);
  const saida = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const p = saida[s.outputNames[0]].data;
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < S * S; i++) { mi = Math.min(mi, p[i]); ma = Math.max(ma, p[i]); }
  const peq = new ImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = Math.round(((p[i] - mi) / Math.max(ma - mi, 1e-12)) * 255);
    peq.data[4 * i] = peq.data[4 * i + 1] = peq.data[4 * i + 2] = v;
    peq.data[4 * i + 3] = 255;
  }
  const t1 = new OffscreenCanvas(S, S);
  t1.getContext('2d').putImageData(peq, 0, 0);
  const t2 = new OffscreenCanvas(W, H);
  const c2 = t2.getContext('2d', { willReadFrequently: true });
  c2.imageSmoothingQuality = 'high';
  c2.drawImage(t1, 0, 0, W, H);
  const g = c2.getImageData(0, 0, W, H).data;
  const mascara = new Uint8Array(W * H);
  let objeto = 0;
  for (let i = 0; i < W * H; i++) {
    // probabilidade SUAVE (0–255): o motor binariza para medir e usa os tons intermediários
    // para compor o recorte sem halo (Blur-Fusion, Forte/Photoroom ICIP 2021)
    mascara[i] = g[4 * i];
    objeto += g[4 * i] > 127;
  }
  return { mascara, W, H, cobertura: objeto / (W * H) };
}

// ── SlimSAM: recorte por clique (pré-processamento padrão do Segment Anything) ──
async function samEmbutir(chave, bytes) {
  const bmp = await bitmap(bytes);
  const { width: W, height: H } = bmp;
  const esc = 1024 / Math.max(W, H);
  const w = Math.round(W * esc), h = Math.round(H * esc);
  const px = pixels(bmp, w, h);
  const media = [123.675, 116.28, 103.53], desvio = [58.395, 57.12, 57.375];
  const x = new Float32Array(3 * 1024 * 1024); // padding com zero (já normalizado) à direita/embaixo
  for (let y = 0; y < h; y++) {
    for (let xx = 0; xx < w; xx++) {
      const i = 4 * (y * w + xx);
      for (let c = 0; c < 3; c++) x[c * 1048576 + y * 1024 + xx] = (px[i + c] - media[c]) / desvio[c];
    }
  }
  const enc = await sessao(SAM.encoder, `${SAM.rotulo} (codificador)`);
  progresso(`codificando a imagem com ${SAM.rotulo} (${acelerador})…`);
  const r = await enc.run({ pixel_values: new ort.Tensor('float32', x, [1, 3, 1024, 1024]) });
  samCache.set(chave, { W, H, esc, emb: r.image_embeddings, pos: r.image_positional_embeddings });
}

async function samMascara(chave, pontos) {
  const c = samCache.get(chave);
  if (!c) throw new Error('imagem não codificada para o recorte por clique');
  const n = pontos.length;
  const coords = new Float32Array(2 * n);
  const rotulos = new BigInt64Array(n);
  pontos.forEach((p, k) => {
    coords[2 * k] = p.x * c.esc;
    coords[2 * k + 1] = p.y * c.esc;
    rotulos[k] = p.positivo ? 1n : 0n;
  });
  const dec = await sessao(SAM.decoder, `${SAM.rotulo} (decodificador)`);
  const r = await dec.run({
    input_points: new ort.Tensor('float32', coords, [1, 1, n, 2]),
    input_labels: new ort.Tensor('int64', rotulos, [1, 1, n]),
    image_embeddings: c.emb,
    image_positional_embeddings: c.pos,
  });
  const iou = r.iou_scores.data;
  const lg = r.pred_masks.data; // [1,1,3,256,256] logits na grade 1024 (com padding)
  // 1 clique é ambíguo (parte × objeto inteiro): fica a MAIOR máscara entre as confiáveis
  // (iou ≥ 0,7) — medido: na foto da planificação, a máscara inteira deu IoU 0,981 com o ISNet
  // mas tinha score menor que as sub-partes. Com vários cliques, vale o maior score (padrão SAM).
  const area = (k) => {
    let a = 0;
    for (let i = k * 65536; i < (k + 1) * 65536; i++) a += lg[i] > 0;
    return a;
  };
  let k = [0, 1, 2].reduce((a, b) => (iou[b] > iou[a] ? b : a), 0);
  if (n === 1) {
    const conf = [0, 1, 2].filter((j) => iou[j] >= 0.7);
    if (conf.length) k = conf.reduce((a, b) => (area(b) > area(a) ? b : a), conf[0]);
  }
  const base = k * 65536;
  const { W, H, esc } = c;
  const mascara = new Uint8Array(W * H);
  let objeto = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // pixel original → grade 1024 → grade 256 (bilinear nos logits)
      const u = Math.min(255, Math.max(0, (x + 0.5) * esc / 4 - 0.5));
      const v = Math.min(255, Math.max(0, (y + 0.5) * esc / 4 - 0.5));
      const u0 = Math.floor(u), v0 = Math.floor(v), u1 = Math.min(255, u0 + 1), v1 = Math.min(255, v0 + 1);
      const tu = u - u0, tv = v - v0;
      const val =
        lg[base + v0 * 256 + u0] * (1 - tu) * (1 - tv) + lg[base + v0 * 256 + u1] * tu * (1 - tv) +
        lg[base + v1 * 256 + u0] * (1 - tu) * tv + lg[base + v1 * 256 + u1] * tu * tv;
      const on = val > 0;
      mascara[y * W + x] = on ? 255 : 0;
      objeto += on;
    }
  }
  return { mascara, W, H, cobertura: objeto / (W * H), iou: iou[k] };
}

// ── Depth Anything V2: disparidade relativa (lado menor 518, múltiplo de 14, ImageNet) ──
async function disparidade(bytes, wAlvo, hAlvo) {
  const bmp = await bitmap(bytes);
  const { width: W, height: H } = bmp;
  const esc = 518 / Math.min(W, H);
  const w = Math.max(14, Math.round((W * esc) / 14) * 14), h = Math.max(14, Math.round((H * esc) / 14) * 14);
  const px = pixels(bmp, w, h);
  const media = [0.485, 0.456, 0.406], desvio = [0.229, 0.224, 0.225];
  const x = new Float32Array(3 * w * h);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    for (let c = 0; c < 3; c++) x[c * w * h + j] = (px[i + c] / 255 - media[c]) / desvio[c];
  }
  const s = await sessao(PROFUNDIDADE.arquivo, PROFUNDIDADE.rotulo);
  progresso(`estimando a profundidade com ${PROFUNDIDADE.rotulo} (${acelerador})…`);
  const r = await s.run({ pixel_values: new ort.Tensor('float32', x, [1, 3, h, w]) });
  const d = r.predicted_depth;
  const [ho, wo] = d.dims.slice(-2);
  const fonte = d.data;
  const out = new Float32Array(wAlvo * hAlvo);
  for (let y = 0; y < hAlvo; y++) {
    for (let xx = 0; xx < wAlvo; xx++) {
      const u = Math.min(wo - 1, (xx + 0.5) * (wo / wAlvo)), v = Math.min(ho - 1, (y + 0.5) * (ho / hAlvo));
      out[y * wAlvo + xx] = fonte[Math.floor(v) * wo + Math.floor(u)];
    }
  }
  return out;
}

/** Reduz uma máscara W×H para w×h (vizinho mais próximo). */
function reduzirMascara(m, W, H, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = m[Math.min(H - 1, Math.floor(((y + 0.5) * H) / h)) * W + Math.min(W - 1, Math.floor(((x + 0.5) * W) / w))];
  return out;
}

/** Item recém-adicionado ao lote → mensagem transferível (pool → coordenador). */
function exportarUltimo() {
  const i = lote.quantidade() - 1;
  const [resumo, nomes, dados, faca] = lote.exportar_item(i);
  const buffers = Array.from(dados).map((u) => u.buffer);
  lote.limpar();
  return { r: { resumo, nomes, dados: buffers, faca }, transf: buffers };
}

async function tratar(acao, dados) {
  switch (acao) {
    case 'iniciar':
      await garantirMotor();
      if (PAPEL === 'coordenador') await carregarOrt(dados?.preferirGpu !== false);
      return {
        versao: versao(),
        modelos: JSON.parse(modelos_json()),
        removedores: Object.fromEntries(Object.entries(MODELOS).map(([k, v]) => [k, v.rotulo])),
        acelerador,
        simd: SIMD,
        isolado: !!self.crossOriginIsolated,
      };
    // ── motor (pool): analisa e devolve o item exportado ──
    case 'analisar_mascara': {
      await garantirMotor();
      lote.adicionar_imagem_mascara(dados.nome, new Uint8Array(dados.bytes), new Uint8Array(dados.mascara), dados.W, dados.H, dados.opcoes);
      return exportarUltimo();
    }
    case 'analisar_classico': {
      await garantirMotor();
      lote.adicionar_imagem(dados.nome, new Uint8Array(dados.bytes), dados.opcoes);
      return exportarUltimo();
    }
    // ── coordenador ──
    case 'mascara': {
      const m = await mascaraNeural(dados.bytes, dados.removedor);
      return { r: { mascara: m.mascara.buffer, W: m.W, H: m.H, cobertura: m.cobertura, removedor: MODELOS[dados.removedor].rotulo, acelerador }, transf: [m.mascara.buffer] };
    }
    case 'importar':
      return JSON.parse(lote.importar_item(dados.resumo, dados.nomes, dados.dados.map((b) => new Uint8Array(b)), dados.faca ?? undefined));
    case 'imagem': {
      // caminho de UM worker só (aparelho com pouca memória): máscara + análise aqui mesmo
      const chave = dados.removedor || 'isnet';
      if (MODELOS[chave]) {
        try {
          const m = await mascaraNeural(dados.bytes, chave);
          progresso(`analisando ${dados.nome} (objeto em ${(100 * m.cobertura).toFixed(1)}% da imagem)…`);
          const r = JSON.parse(lote.adicionar_imagem_mascara(dados.nome, new Uint8Array(dados.bytes), m.mascara, m.W, m.H, dados.opcoes));
          r.removedor_neural = MODELOS[chave].rotulo;
          r.acelerador = acelerador;
          return r;
        } catch (e) {
          progresso(`removedor neural indisponível (${e.message || e}) — usando o isolamento clássico`);
        }
      }
      return JSON.parse(lote.adicionar_imagem(dados.nome, new Uint8Array(dados.bytes), dados.opcoes));
    }
    case 'sam_embutir':
      await samEmbutir(dados.chave, dados.bytes);
      return true;
    case 'sam_mascara': {
      const m = await samMascara(dados.chave, dados.pontos);
      return { r: { mascara: m.mascara.buffer, W: m.W, H: m.H, cobertura: m.cobertura, iou: m.iou }, transf: [m.mascara.buffer] };
    }
    case 'reanalisar': {
      // recorte refinado por clique: troca o item `indice` pela nova análise (vai para o fim)
      lote.remover(dados.indice);
      const r = JSON.parse(lote.adicionar_imagem_mascara(dados.nome, new Uint8Array(dados.bytes), new Uint8Array(dados.mascara), dados.W, dados.H, dados.opcoes));
      r.removedor_neural = 'SlimSAM (recorte por clique)';
      return r;
    }
    case 'caixa_montada': {
      const m = await mascaraNeural(dados.bytes, dados.removedor || 'isnet');
      const esc = Math.min(1, 640 / Math.max(m.W, m.H));
      const w = Math.max(32, Math.round(m.W * esc)), h = Math.max(32, Math.round(m.H * esc));
      const masc = reduzirMascara(m.mascara, m.W, m.H, w, h);
      const disp = dados.profundidade ? await disparidade(dados.bytes, w, h) : new Float32Array(0);
      progresso(`ajustando o cuboide 3D por silhueta e arestas…`);
      const r = JSON.parse(lote.adicionar_caixa_montada(dados.nome, new Uint8Array(dados.bytes), masc, disp, w, h, dados.opcoes));
      r.acelerador = acelerador;
      return r;
    }
    case 'quadros':
      return JSON.parse(lote.adicionar_quadros(dados.nome, dados.quadros.map((b) => new Uint8Array(b)), dados.largura, dados.altura, dados.opcoes));
    case 'modelo':
      return JSON.parse(lote.adicionar_modelo(dados.modelo, dados.params, dados.opcoes));
    case 'encaixar_lote':
      return JSON.parse(lote.encaixar_lote(dados.opcoes));
    case 'marcadores': {
      const b = marcadores_pdf(dados.lado || 40);
      return { r: b.buffer, transf: [b.buffer] };
    }
    case 'arquivo': {
      const b = lote.arquivo(dados.indice, dados.nome);
      return b ? { r: b.buffer, transf: [b.buffer] } : null;
    }
    case 'zip': {
      const z = lote.zip();
      return { r: z.buffer, transf: [z.buffer] };
    }
    case 'limpar':
      lote.limpar();
      samCache.clear();
      return true;
    default:
      throw new Error(`ação desconhecida: ${acao}`);
  }
}

self.onmessage = async (ev) => {
  const { id, acao, dados } = ev.data;
  try {
    await garantirMotor();
    const saida = await tratar(acao, dados);
    if (saida && typeof saida === 'object' && 'transf' in saida && 'r' in saida) {
      self.postMessage({ id, ok: true, r: saida.r }, saida.transf);
    } else {
      self.postMessage({ id, ok: true, r: saida });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, erro: String(e && e.message ? e.message : e) });
  }
};
