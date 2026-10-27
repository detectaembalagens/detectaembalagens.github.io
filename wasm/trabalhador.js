// EngRevFacaEmbalagem
// Autor: ProfBru - Bruno Penedo © 2026 - TODOS OS DIREITOS RESERVADOS
// E-mail: profbruanbima@gmail.com
//
// Web Worker: roda o motor Rust/WASM E o removedor de fundo neural (rembg via ONNX
// Runtime Web) fora da thread da interface. Nada sai do navegador — a foto do cliente
// nunca vai para servidor nenhum; o modelo é baixado uma vez e fica em cache local.
//
// ETAPA 0 (diretriz permanente): fundo removido ANTES da análise.
//   isnet  — ISNet general-use quantizado int8 (44 MB; IoU ≥ 0,99 contra o fp32) · padrão
//   u2netp — U²-Net leve (4 MB): rápido, bom para planificação simples
//   classico — segmentação própria do motor (sem modelo)

import iniciar, { Lote, modelos_json, versao } from './faca_motor.js';
import * as ort from '../ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('../ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // GitHub Pages não envia COOP/COEP: sem threads compartilhadas

const MODELOS = {
  isnet: { arquivo: 'isnet-general-use.int8.onnx', lado: 1024, media: [0.5, 0.5, 0.5], desvio: [1, 1, 1], rotulo: 'ISNet (int8)' },
  u2netp: { arquivo: 'u2netp.onnx', lado: 320, media: [0.485, 0.456, 0.406], desvio: [0.229, 0.224, 0.225], rotulo: 'U²-Netp' },
};
const CACHE = 'detectaembalagens-modelos-v1';

let lote = null;
const sessoes = {};

async function garantir() {
  if (!lote) {
    await iniciar(new URL('./faca_motor_bg.wasm', import.meta.url));
    lote = new Lote();
  }
}

function progresso(texto) {
  self.postMessage({ progresso: texto });
}

/** Baixa o modelo uma vez (Cache Storage) — depois funciona offline. */
async function baixarModelo(url, rotulo) {
  let resp = null;
  try {
    const c = await caches.open(CACHE);
    resp = await c.match(url);
    if (!resp) {
      progresso(`baixando o modelo ${rotulo} (só na primeira vez)…`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await c.put(url, r.clone());
      resp = r;
    }
  } catch (e) {
    // sem Cache Storage (contexto inseguro): baixa direto
    resp = await fetch(url);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

async function sessao(chave) {
  if (!sessoes[chave]) {
    const m = MODELOS[chave];
    const bytes = await baixarModelo(new URL(`../modelos/${m.arquivo}`, import.meta.url).href, m.rotulo);
    progresso(`preparando ${m.rotulo}…`);
    sessoes[chave] = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  return sessoes[chave];
}

/** Máscara do objeto (0/255, tamanho original) — pré/pós-processamento idênticos ao rembg. */
async function mascaraNeural(bytes, chave) {
  const m = MODELOS[chave];
  const bmp = await createImageBitmap(new Blob([bytes]));
  const { width: W, height: H } = bmp;
  const S = m.lado;
  const tela = new OffscreenCanvas(S, S);
  const cx = tela.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, S, S);
  const px = cx.getImageData(0, 0, S, S).data;
  let max = 1e-6;
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
  const x = new Float32Array(3 * S * S);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    for (let c = 0; c < 3; c++) x[c * S * S + j] = (px[i + c] / max - m.media[c]) / m.desvio[c];
  }
  const s = await sessao(chave);
  progresso(`removendo o fundo com ${m.rotulo}…`);
  const saida = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const p = saida[s.outputNames[0]].data; // [1,1,S,S]
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
    const on = g[4 * i] > 127;
    mascara[i] = on ? 255 : 0;
    objeto += on;
  }
  return { mascara, W, H, cobertura: objeto / (W * H) };
}

self.onmessage = async (ev) => {
  const { id, acao, dados } = ev.data;
  try {
    await garantir();
    let r;
    switch (acao) {
      case 'iniciar':
        r = { versao: versao(), modelos: JSON.parse(modelos_json()), removedores: Object.fromEntries(Object.entries(MODELOS).map(([k, v]) => [k, v.rotulo])) };
        break;
      case 'imagem': {
        const chave = dados.removedor || 'isnet';
        if (MODELOS[chave]) {
          try {
            const m = await mascaraNeural(dados.bytes, chave);
            progresso(`analisando ${dados.nome} (objeto em ${(100 * m.cobertura).toFixed(1)}% da imagem)…`);
            r = JSON.parse(lote.adicionar_imagem_mascara(dados.nome, new Uint8Array(dados.bytes), m.mascara, m.W, m.H, dados.opcoes));
            r.removedor_neural = MODELOS[chave].rotulo;
            break;
          } catch (e) {
            progresso(`removedor neural indisponível (${e.message || e}) — usando o isolamento clássico`);
          }
        }
        r = JSON.parse(lote.adicionar_imagem(dados.nome, new Uint8Array(dados.bytes), dados.opcoes));
        break;
      }
      case 'quadros':
        r = JSON.parse(lote.adicionar_quadros(dados.nome, dados.quadros.map((b) => new Uint8Array(b)), dados.largura, dados.altura, dados.opcoes));
        break;
      case 'modelo':
        r = JSON.parse(lote.adicionar_modelo(dados.modelo, dados.params, dados.opcoes));
        break;
      case 'arquivo': {
        const b = lote.arquivo(dados.indice, dados.nome);
        r = b ? b.buffer : null;
        break;
      }
      case 'zip': {
        const z = lote.zip();
        r = z.buffer;
        break;
      }
      case 'limpar':
        lote.limpar();
        r = true;
        break;
      default:
        throw new Error(`ação desconhecida: ${acao}`);
    }
    const transf = r instanceof ArrayBuffer ? [r] : [];
    self.postMessage({ id, ok: true, r }, transf);
  } catch (e) {
    self.postMessage({ id, ok: false, erro: String(e && e.message ? e.message : e) });
  }
};
