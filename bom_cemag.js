// bom_cemag.js
// Automação BOM CEMAG — busca produtos da API, filtra e processa em lotes de 100
// Execução completa : node bom_cemag.js
// Execução de teste : node bom_cemag.js --teste   (processa só os primeiros 20 itens)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
require('dotenv').config();
const XLSX = require('xlsx');

const MODO_TESTE = process.argv.includes('--teste');
const MODO_TRATAR_ONLY = process.argv.includes('--tratar-only');
const BATCH_SIZE = 100;
const TESTE_SIZE = 1;
const MAX_LOTES = null;
const CORES = ['VJ', 'VM', 'AN', 'LC', 'LJ', 'AM', 'AV', 'CO'];
const DB_SCHEMA = process.env.BASE_TESTE || 'public';
const CARRETAS_TABLE_NAME = process.env.CARRETAS_EXPLODIDAS_TABLE || 'cadastro_carretasexplodidas';
const ITENS_EXPLODIDOS_TABLE_NAME = process.env.ITENS_EXPLODIDOS_TABLE || 'cadastro_itensexplodidos';
const CARRETAS_TABLE = `${DB_SCHEMA}.${CARRETAS_TABLE_NAME}`;
const ITENS_EXPLODIDOS_TABLE = `${DB_SCHEMA}.${ITENS_EXPLODIDOS_TABLE_NAME}`;
const KEY_FIELDS = ['codigo_peca', 'carreta', 'conjunto_peca'];
const ALL_MODEL_FIELDS = [
  'codigo_peca',
  'descricao_peca',
  'mp_peca',
  'total_peca',
  'conjunto_peca',
  'primeiro_processo',
  'segundo_processo',
  'carreta',
  'grupo',
  'grupo1',
  'grupo2',
  'peso'
];
const SOURCE_TO_MODEL = {
  'CODIGO': 'codigo_peca',
  'DESCRIÃ‡ÃƒO': 'descricao_peca',
  'MATÃ‰RIA PRIMA': 'mp_peca',
  'TOTAL': 'total_peca',
  'PRIMEIRO PROCESSO': 'primeiro_processo',
  '2 PROCESSO': 'segundo_processo',
  'CONJUNTO': 'conjunto_peca',
  'CARRETA': 'carreta',
  'CELULA 3': 'grupo',
  'CELULA 1': 'grupo1',
  'CELULA 2': 'grupo2',
  'PESO': 'peso'
};
const MANUAL_COMPONENTE_EXTRA = new Set([
  '214104', '214105', '214108', '262729', '200391', '240471', '222416', '268150', '218455'
]);

// ── Lógica de filtragem (equivalente ao Python puxando_carretas) ──────────────

async function puxandoCarretas() {
  const res = await fetch('https://cemag.innovaro.com.br/api/publica/v1/tabelas/listarProdutos');
  const dados = await res.json();

  const codigoCarretas = [];      // sem cor
  const carretasComCores = [];    // com cor
  const carretasBaseCompleto = []; // {chave, codigo} de todos

  for (const produto of dados.produtos) {
    if (
      produto.CRM !== null &&
      produto.CRM !== undefined &&
      !produto.nome.toLowerCase().includes('fora de linha') &&
      !produto.codigo.toLowerCase().includes('fora de linha') &&
      !produto.codigo.includes('+')
    ) {
      const partes = produto.codigo.split(' ');
      const cor_t1 = partes.at(-1) || '';
      const cor_t2 = partes.at(-2) || '';
      const cor_t3 = partes.at(-3) || '';
      const cor_numerico = produto.codigo.slice(-2);

      const temCor = CORES.some(c => [cor_t1, cor_t2, cor_t3, cor_numerico].includes(c));

      if (temCor) {
        carretasComCores.push(produto.codigo.trim());
      } else {
        codigoCarretas.push(produto.codigo.trim());
      }

      carretasBaseCompleto.push({
        chave: String(produto.chave).trim(),
        codigo: produto.codigo.trim()
      });
    }
  }

  console.log(`Sem cor: ${codigoCarretas.length} | Com cor: ${carretasComCores.length}`);
  return { codigoCarretas, carretasComCores, carretasBaseCompleto };
}

async function carregarItensExplodidos() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const query = `SELECT produto FROM ${ITENS_EXPLODIDOS_TABLE}`;
    const { rows } = await client.query(query);
    const itensLimpos = rows
      .map((row) => String(row.produto ?? '').trim())
      .filter(Boolean);
    console.log(`ItensExplodidos carregados: ${itensLimpos.length}`);
    return itensLimpos;
  } finally {
    await client.end().catch(() => {});
  }
}

async function processarListaChaves() {
  const { codigoCarretas, carretasComCores, carretasBaseCompleto } = await puxandoCarretas();

  // Remove de carretasComCores os que têm base em codigoCarretas
  let comCoresFiltradas = [...carretasComCores];
  for (const base of codigoCarretas) {
    const correspondentes = comCoresFiltradas.filter(c => c.startsWith(base));
    for (const c of correspondentes) {
      const idx = comCoresFiltradas.indexOf(c);
      if (idx > -1) comCoresFiltradas.splice(idx, 1);
    }
  }

  // Agrupa os restantes por base (removendo a cor) e sorteia 1 por grupo
  const grupos = {};
  for (const item of comCoresFiltradas) {
    let encontrou = false;
    for (const cor of CORES) {
      if (item.includes(` ${cor} `) || item.endsWith(` ${cor}`) || item.endsWith(cor)) {
        const base = item.replace(new RegExp(`\\s*${cor}\\s*$`), '').trim();
        if (!grupos[base]) grupos[base] = [];
        grupos[base].push(item);
        encontrou = true;
        break;
      }
    }
    if (!encontrou) {
      if (!grupos['OUTROS']) grupos['OUTROS'] = [];
      grupos['OUTROS'].push(item);
    }
  }

  const sorteados = Object.values(grupos).map(itens =>
    itens[Math.floor(Math.random() * itens.length)]
  );

  const listaCompleta = [...new Set([...codigoCarretas, ...sorteados])];

  // Separa itens com PE
  const listaComPE = listaCompleta.filter(x => x.includes('PE'));
  const listaSemPE  = listaCompleta.filter(x => !x.includes('PE'));

  // Resolve chaves
  const listaSemPESet = new Set(listaSemPE);
  const chavesNormais = [];
  for (const item of carretasBaseCompleto) {
    if (listaSemPESet.has(item.codigo)) {
      chavesNormais.push(item.chave);
    }
  }

  const itensModel = await carregarItensExplodidos();
  const listaFinal = [...new Set([...chavesNormais, ...itensModel])];
  console.log(`Total de chaves para processar: ${listaFinal.length}`);
  return listaFinal;
}

// ── Automação Playwright ──────────────────────────────────────────────────────

function limparAspasEnv(valor) {
  return String(valor ?? '').trim().replace(/^['"]|['"]$/g, '');
}

function contarPontosInicio(valor) {
  if (valor == null) return 0;
  const texto = String(valor).replace(/^\s+/, '');
  const match = texto.match(/^((\.\s*)+)/);
  return match ? (match[0].match(/\./g) || []).length : 0;
}

function limparEspacosUnicode(texto) {
  if (texto == null) return texto;
  const numeroPontos = contarPontosInicio(texto);
  let resultado = String(texto);
  for (let i = 0; i < numeroPontos; i++) resultado = resultado.replace('.', '');
  return resultado.replace(/^\s+|\s+$/gu, '');
}

function definirPrimeiroProcesso(texto) {
  const mapa = [
    ['S Mont Prod Especiais', 'MONTAR'],
    ['S Mont Conjuntos Carretas', 'MONTAR'],
    ['S Pintura', 'PINTAR'],
    ['S Expedição', 'EXPEDIR'],
    ['S C Serras', 'SERRAR'],
    ['S C Plasma', 'CORTAR'],
    ['S C Guilhotina', 'CORTAR'],
    ['S Corte Manual', 'CORTAR'],
    ['S C Prensas', 'CORTAR'],
    ['S C Laser', 'CORTAR'],
    ['S Usinagem', 'C USINAR'],
    ['S Mont Sistemas Carretas', 'MONTAR'],
    ['S Cx Acessórios - P Setor Cx Acessórios', 'CX']
  ];
  if (texto == null) return '';
  const valor = String(texto);
  for (const [chave, retorno] of mapa) if (valor.includes(chave)) return retorno;
  return '';
}

function classificarCodigo(codigo, valorAtual) {
  const codigoStr = String(codigo ?? '');
  if (codigoStr.startsWith('2')) return 'COMPONENTES';
  if (codigoStr.startsWith('3')) return 'SECUNDÁRIOS';
  if (codigoStr.startsWith('116')) return 'COMP. NAVAL';
  return valorAtual;
}

function observacaoDiferente(row) {
  const obs = row.observacao_proximo;
  const descricao2Depois = row.descricao_2_depois;
  const observacoes = ['PINTAR', 'MONTAR', 'PINTURA', 'EXPEDIR'];
  return !observacoes.includes(obs) ? descricao2Depois : '';
}

function buscarConjuntos(rows) {
  const ultimosPorPonto = new Map();
  return rows.map((row) => {
    const pontos = row['NUMERO DE PONTOS'];
    const chaveAlvo = pontos - 2;
    const resultado = ultimosPorPonto.get(chaveAlvo) || '';
    ultimosPorPonto.set(pontos, typeof row['DESCRIÇÃO'] === 'string' ? row['DESCRIÇÃO'].trim() : '');
    return resultado;
  });
}

function verificaDescricao3Depois(rowIndex, rows) {
  const idx3Depois = rowIndex + 3;
  if (idx3Depois >= rows.length) return '';
  const descricao3 = rows[idx3Depois]['DESCRIÇÃO'];
  return ['S Estamparia - P Estamparia', 'S Usinagem - P Setor Usinagem'].includes(descricao3)
    ? String(descricao3).trim()
    : '';
}

function definirPeso(row) {
  const obs = String(row.observacao_proximo ?? '').trim().toUpperCase();
  const observacoes = ['PINTAR', 'MONTAR', 'PINTURA', 'EXPEDIR'];
  return !observacoes.includes(obs) && obs !== '' ? row.TOTAL_PROXIMO_2 : '';
}

function extrairCarreta(produto) {
  if (produto == null || String(produto).trim() === '') return '';
  try {
    const prefixo = String(produto).split(' - ')[0].trim();
    return prefixo.replace(/(LC|LH|VM|VJ|AN|AV)$/u, '').trim();
  } catch {
    return '';
  }
}

function classificarProduto(row) {
  const processo = row['PRIMEIRO PROCESSO'];
  const b = row['CELULA 2'] != null ? String(row['CELULA 2']) : '';
  const conjunto = row['CONJUNTO'] != null ? String(row['CONJUNTO']) : '';
  if (processo === 'MONTAR' || processo === 'PINTAR') return '';
  if (b === 'LATERAL') {
    if (conjunto.includes('LATE')) return 'LATERAL';
    if (conjunto.includes('DIANT')) return 'DIANTEIRA';
    if (conjunto.includes('TRASE')) return 'TRASEIRA';
  }
  if (b === 'IÇAMENTO' && conjunto.includes('029989')) return '5ª RODA';
  if ((b === 'IÇAMENTO' || b === 'EIXO') && conjunto.includes('025840')) return '5ª RODA';
  if (b === 'CILINDRO' || b === 'CILINDRO 2') return 'CILINDRO';
  if (b === 'EIXO' && ['031737', '031755', '031291', '031776'].some((cod) => conjunto.includes(cod))) return 'SUPORTE';
  return b || '';
}

function concatenarColunas(rows, colunas, nomeNovaColuna, separador = ' - ') {
  return rows.map((row) => ({
    ...row,
    [nomeNovaColuna]: colunas.map((coluna) => String(row[coluna] ?? '')).join(separador)
  }));
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function obterAccessTokenGoogle() {
  const clientEmail = limparAspasEnv(process.env.client_email);
  const privateKey = limparAspasEnv(process.env.private_key).replace(/\\n/g, '\n');
  const tokenUri = limparAspasEnv(process.env.token_uri) || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: tokenUri,
    exp: now + 3600,
    iat: now
  }));
  const assinaturaBase = `${header}.${claim}`;
  const assinatura = crypto.createSign('RSA-SHA256').update(assinaturaBase).sign(privateKey, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${assinaturaBase}.${assinatura}`
  });
  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) throw new Error(`Falha ao obter token do Google: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  return payload.access_token;
}

async function conectarPlanilhaApontamento() {
  const accessToken = await obterAccessTokenGoogle();
  const sheetId = '1x26yfwoF7peeb59yJuJuxCQNlqjCjh65NYS1RIrC0Zc';
  const range = encodeURIComponent('RQ PCP 002-000 (APONTAMENTO MONTAGEM)');
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`Falha ao ler Google Sheets: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const values = payload.values || [];
  if (values.length < 6) return [];
  const header = values[4];
  const idxCodigo = header.indexOf('Código');
  const idxCelula = header.indexOf('Célula');
  if (idxCodigo === -1 || idxCelula === -1) throw new Error('Colunas Código/Célula não encontradas na planilha.');
  const agrupado = new Map();
  for (const row of values.slice(5)) {
    const codigo = String(row[idxCodigo] || '').trim();
    const celula = String(row[idxCelula] || '').trim();
    if (!codigo || !celula) continue;
    agrupado.set(codigo, { Código: codigo, Célula: celula });
  }
  return [...agrupado.values()];
}

async function tratarDadosFinais(listaDados) {
  const colunasBase = ['Recurso', 'Qtd.', 'TOTAL', 'Und.', 'Observação', 'Depósito Origem', 'Depósito Destino', 'Custo'];
  const rows = listaDados
    .filter((row) => Array.isArray(row) && row.length === 8 && row[0] !== 'Recurso')
    .map((row) => Object.fromEntries(colunasBase.map((coluna, idx) => [coluna, row[idx] ?? ''])));

  rows.forEach((row) => {
    row['DESCRIÇÃO'] = limparEspacosUnicode(row['Recurso']);
    row['CODIGO'] = row['DESCRIÇÃO'] ? String(row['DESCRIÇÃO']).split(' ')[0] : '';
    row['NUMERO DE PONTOS'] = contarPontosInicio(row['Recurso']);
  });
  rows.forEach((row, idx) => {
    row.descricao_proxima = rows[idx + 1]?.['DESCRIÇÃO'] || '';
    row['PRIMEIRO PROCESSO'] = classificarCodigo(row['CODIGO'], definirPrimeiroProcesso(row.descricao_proxima));
    row.observacao_proximo = rows[idx + 1]?.['Observação'] || '';
    row.descricao_2_depois = rows[idx + 2]?.['DESCRIÇÃO'] || '';
  });
  rows.forEach((row) => { row['MATÉRIA PRIMA'] = observacaoDiferente(row); });
  const conjuntos = buscarConjuntos(rows);
  rows.forEach((row, idx) => {
    row['CONJUNTO'] = conjuntos[idx] || '';
    row['2 PROCESSO'] = verificaDescricao3Depois(idx, rows);
    row.TOTAL_PROXIMO_2 = rows[idx + 2]?.TOTAL || '';
    row['PESO'] = definirPeso(row);
  });
  let produtoAtual = '';
  rows.forEach((row) => {
    if (row['NUMERO DE PONTOS'] === 0 && row['DESCRIÇÃO']) produtoAtual = row['DESCRIÇÃO'];
    row['PRODUTO'] = produtoAtual;
  });

  const filtrado = rows.filter((row) => {
    const codigo = String(row['CODIGO'] || '');
    const processo = String(row['PRIMEIRO PROCESSO'] || '');
    const filtroProcesso =
      codigo.startsWith('116') ||
      ['CORTAR', 'SERRAR', 'MONTAR', 'PINTAR', 'C USINAR', 'SECUNDÁRIOS', 'COMPONENTES', 'CX']
        .some((prefixo) => processo.startsWith(prefixo));
    const excluir = ['11', '13', '120', '126', 'S'].some((prefixo) => codigo.startsWith(prefixo)) && !codigo.startsWith('116');
    return filtroProcesso && !excluir;
  }).map((row) => ({
    ...row,
    CODIGO_SPLIT_CONJUNTO: String(row['CONJUNTO'] || '').split('-', 1)[0].trim()
  }));

  const codigosAtualizados = await conectarPlanilhaApontamento();
  const mapaCelulas = new Map(codigosAtualizados.map((item) => [String(item['Código']).trim(), item['Célula']]));
  let merge = filtrado.map((row) => {
    const celula = mapaCelulas.get(String(row.CODIGO_SPLIT_CONJUNTO || '').trim()) || '';
    return {
      ...row,
      'CELULA 1': celula,
      'CELULA 2': celula,
      'CELULA 3': '',
      'CARRETA': extrairCarreta(row['PRODUTO']),
      'CARRETA TRATADA': ''
    };
  });
  merge = merge.map((row) => ({ ...row, 'CELULA 3': classificarProduto(row) }));
  merge = concatenarColunas(merge, ['CODIGO', 'CARRETA'], 'peça + carreta');
  return merge.map((row) => ({
    'CELULA 1': row['CELULA 1'] || '',
    'CELULA 2': row['CELULA 2'] || '',
    'CELULA 3': row['CELULA 3'] || '',
    'CODIGO': row['CODIGO'] || '',
    'DESCRIÇÃO': row['DESCRIÇÃO'] || '',
    'MATÉRIA PRIMA': row['MATÉRIA PRIMA'] || '',
    'TOTAL': row['TOTAL'] || '',
    'CONJUNTO': row['CONJUNTO'] || '',
    'PRIMEIRO PROCESSO': row['PRIMEIRO PROCESSO'] || '',
    '2 PROCESSO': row['2 PROCESSO'] || '',
    'PESO': row['PESO'] || '',
    'PRODUTO': row['PRODUTO'] || '',
    'CARRETA': row['CARRETA'] || '',
    'CARRETA TRATADA': row['CARRETA TRATADA'] || '',
    'peça + carreta': row['peça + carreta'] || ''
  }));
}

function chunked(array, size = 1000) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

function cleanCell(value) {
  if (value == null) return null;
  const text = String(value);
  if (text.toLowerCase() === 'nan' || text.trim() === '') return null;
  return text.trim();
}

function normalizeCarretasRows(sourceRows) {
  return sourceRows.map((row) => {
    const mapped = {};
    for (const [source, target] of Object.entries(SOURCE_TO_MODEL)) {
      mapped[target] = cleanCell(row[source]);
    }
    mapped.codigo_peca = cleanCell(mapped.codigo_peca);
    if (mapped.codigo_peca && MANUAL_COMPONENTE_EXTRA.has(mapped.codigo_peca)) {
      mapped.primeiro_processo = 'COMPONENTE EXTRA';
    }
    return mapped;
  });
}

async function getPgClient() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  return client;
}

async function insertCarretasChunk(client, rows) {
  if (!rows.length) return 0;
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const base = rowIndex * ALL_MODEL_FIELDS.length;
    for (const field of ALL_MODEL_FIELDS) values.push(row[field] ?? null);
    return `(${ALL_MODEL_FIELDS.map((_, colIndex) => `$${base + colIndex + 1}`).join(', ')})`;
  });
  const sql = `
    INSERT INTO ${CARRETAS_TABLE} (${ALL_MODEL_FIELDS.join(', ')})
    VALUES ${placeholders.join(', ')}
  `;
  await client.query(sql, values);
  return rows.length;
}

async function updateCarretasChunk(client, rows) {
  if (!rows.length) return 0;
  const cols = ['id', ...ALL_MODEL_FIELDS];
  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const base = rowIndex * cols.length;
    values.push(row.id);
    for (const field of ALL_MODEL_FIELDS) values.push(row[field] ?? null);
    return `(${cols.map((_, colIndex) => `$${base + colIndex + 1}`).join(', ')})`;
  });
  const updateFields = ALL_MODEL_FIELDS.map((field) => `${field} = data.${field}`).join(', ');
  const sql = `
    UPDATE ${CARRETAS_TABLE} AS target
    SET ${updateFields}
    FROM (
      VALUES ${placeholders.join(', ')}
    ) AS data (${cols.join(', ')})
    WHERE target.id = data.id::bigint
  `;
  await client.query(sql, values);
  return rows.length;
}

async function syncCarretasFromRows(sourceRows, { updateExisting = true, chunkSize = 1000 } = {}) {
  const normalizedRows = normalizeCarretasRows(sourceRows);
  const client = await getPgClient();

  try {
    await client.query('BEGIN');
    const existingRes = await client.query(`
      SELECT id, ${KEY_FIELDS.join(', ')}
      FROM ${CARRETAS_TABLE}
    `);

    const existingMap = new Map(
      existingRes.rows.map((row) => [
        JSON.stringify(KEY_FIELDS.map((field) => row[field] ?? null)),
        row.id
      ])
    );

    const toCreate = [];
    const toUpdate = [];
    const seen = new Set();

    for (const row of normalizedRows) {
      const key = JSON.stringify(KEY_FIELDS.map((field) => row[field] ?? null));
      if (seen.has(key)) continue;
      seen.add(key);

      const existingId = existingMap.get(key);
      if (!existingId) {
        toCreate.push(row);
      } else if (updateExisting) {
        toUpdate.push({ id: existingId, ...row });
      }
    }

    let created = 0;
    let updated = 0;
    for (const chunk of chunked(toCreate, chunkSize)) created += await insertCarretasChunk(client, chunk);
    for (const chunk of chunked(toUpdate, chunkSize)) updated += await updateCarretasChunk(client, chunk);

    await client.query('COMMIT');
    return {
      created,
      updated,
      existing_kept: existingRes.rows.length
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

async function executarTratamentoSomente() {
  const outPath = 'C:\\bom_cemag\\resultado_bom.xlsx';
  if (!fs.existsSync(outPath)) {
    throw new Error(`Arquivo não encontrado para tratamento: ${outPath}`);
  }

  const wb = XLSX.readFile(outPath);
  const nomeAbaOrigem = wb.SheetNames.includes('BOM RAW') ? 'BOM RAW' : wb.SheetNames[0];
  const wsOrigem = wb.Sheets[nomeAbaOrigem];
  const listaDados = XLSX.utils.sheet_to_json(wsOrigem, { header: 1, raw: false });

  const dadosTratados = await tratarDadosFinais(listaDados);
  const wsTratado = XLSX.utils.json_to_sheet(dadosTratados);
  wb.Sheets['BOM TRATADO'] = wsTratado;
  if (!wb.SheetNames.includes('BOM TRATADO')) wb.SheetNames.push('BOM TRATADO');

  XLSX.writeFile(wb, outPath);
  const syncStats = await syncCarretasFromRows(dadosTratados);
  console.log(`Tratamento final concluído a partir da aba "${nomeAbaOrigem}".`);
  console.log(`Linhas tratadas: ${dadosTratados.length}`);
  console.log(`Sync banco: created=${syncStats.created}, updated=${syncStats.updated}, existing_kept=${syncStats.existing_kept}`);
  console.log(`Excel atualizado em: ${outPath}`);
}

(async () => {
  if (MODO_TRATAR_ONLY) {
    await executarTratamentoSomente();
    return;
  }

  const listaChaves = await processarListaChaves();
  if (listaChaves.length === 0) {
    console.log('Nenhuma chave encontrada. Encerrando.');
    return;
  }

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto('http://192.168.3.140/sistema');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const client = await context.newCDPSession(page);

  // ── Helpers CDP ─────────────────────────────────────────────────────────────

  function attrs(node) {
    const a = node.attributes || [];
    const m = {};
    for (let i = 0; i < a.length; i += 2) m[a[i]] = a[i + 1];
    return m;
  }

  async function dom() {
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    return root;
  }

  function findByName(root, name) {
    if (root.nodeName === 'INPUT' && attrs(root).name === name) return root.nodeId;
    for (const c of root.children || []) { const r = findByName(c, name); if (r) return r; }
    for (const s of root.shadowRoots || []) { const r = findByName(s, name); if (r) return r; }
    if (root.contentDocument) { const r = findByName(root.contentDocument, name); if (r) return r; }
    return null;
  }

  function parentChain(node, name, chain) {
    if (node.nodeName === 'INPUT' && attrs(node).name === name) return [...chain, node];
    for (const c of node.children || []) { const r = parentChain(c, name, [...chain, node]); if (r) return r; }
    for (const s of node.shadowRoots || []) { const r = parentChain(s, name, [...chain, node]); if (r) return r; }
    if (node.contentDocument) { const r = parentChain(node.contentDocument, name, [...chain, node]); if (r) return r; }
    return null;
  }

  function lookupBtn(root, name) {
    const chain = parentChain(root, name, []);
    if (!chain) return null;
    const parent = chain[chain.length - 2];
    for (const sib of parent.children || []) {
      if (sib.nodeName === 'SECTION' && (attrs(sib).class || '').includes('wf-field-cell__trailing')) {
        for (const btn of sib.children || []) {
          if ((attrs(btn).class || '').includes('wf-field-cell__lookup')) return btn.nodeId;
        }
      }
    }
    return null;
  }

  function allCheckboxes(root) {
    const cbs = [];
    function walk(n) {
      if (n.nodeName === 'BUTTON' && (attrs(n).class || '').includes('wf-checkbox'))
        cbs.push({ nodeId: n.nodeId, icon: n.children?.[0]?.children?.[0]?.nodeValue || '' });
      for (const c of n.children || []) walk(c);
      for (const s of n.shadowRoots || []) walk(s);
      if (n.contentDocument) walk(n.contentDocument);
    }
    walk(root);
    return cbs;
  }

  function findBtnByText(root, text) {
    let id = null;
    function walk(n) {
      if (n.nodeName === 'BUTTON') {
        const txt = (n.children || []).map(c => c.nodeValue || c.children?.[0]?.nodeValue || '').join('').trim();
        if (txt === text) { id = n.nodeId; return; }
      }
      for (const c of n.children || []) walk(c);
      for (const s of n.shadowRoots || []) walk(s);
      if (n.contentDocument) walk(n.contentDocument);
    }
    walk(root);
    return id;
  }

  async function clickNode(nodeId) {
    const { model } = await client.send('DOM.getBoxModel', { nodeId });
    await page.mouse.click(
      (model.content[0] + model.content[2]) / 2,
      (model.content[1] + model.content[7]) / 2
    );
  }

  async function fillField(name, value) {
    const id = findByName(await dom(), name);
    if (!id) throw new Error(`Campo não encontrado para fillField: ${name}`);
    await client.send('DOM.focus', { nodeId: id });
    await page.keyboard.press('Control+A');
    await page.keyboard.type(value, { delay: 50 });
    await page.waitForTimeout(300);
  }

  // Insere o valor de uma só vez via CDP Input.insertText
  // (evita disparar lookup caractere por caractere; não depende de clipboard)
  async function pasteField(name, value) {
    const id = findByName(await dom(), name);
    if (!id) throw new Error(`Campo não encontrado para pasteField: ${name}`);
    await client.send('DOM.focus', { nodeId: id });
    await page.keyboard.press('Control+A');
    await client.send('Input.insertText', { text: value });
    await page.waitForTimeout(400);
  }

  async function clearField(name) {
    const id = findByName(await dom(), name);
    if (!id) throw new Error(`Campo não encontrado para clearField: ${name}`);
    await client.send('DOM.focus', { nodeId: id });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
  }

  // Popup de lookup simples (campo único): seleciona 1º checkbox + Ok
  async function handlePopupIfOpen() {
    await page.waitForTimeout(900);
    const root = await dom();
    const cbs = allCheckboxes(root);
    if (cbs.length <= 13) return;
    const popupCbs = cbs.slice(13);
    if (popupCbs[0].icon === 'check_box_outline_blank') {
      await clickNode(popupCbs[0].nodeId);
      await page.waitForTimeout(400);
    }
    const ok = findBtnByText(await dom(), 'Ok');
    if (ok) { await clickNode(ok); await page.waitForTimeout(800); }
  }

  // Popup de múltiplos recursos: aguarda "Todos" aparecer (polling) e clica
  async function handleRecursosPopup() {
    const timeoutMs = 30000;
    const start = Date.now();
    let todosId = null;

    while (Date.now() - start < timeoutMs) {
      const root = await dom();
      todosId = findBtnByText(root, 'Todos');
      if (todosId) break;
      await page.waitForTimeout(500);
    }

    if (!todosId) {
      console.log('    Popup de confirmação não apareceu.');
      return;
    }

    await clickNode(todosId);
    await page.waitForTimeout(400);
    const ok = findBtnByText(await dom(), 'Ok');
    if (ok) { await clickNode(ok); await page.waitForTimeout(800); }
  }

  async function waitForLoadingToFinish(timeoutMs = 180000) {
    await page.waitForTimeout(1000);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const root = await dom();
      let dialogOpen = false;
      function checkDialog(node) {
        const cls = attrs(node).class || '';
        if (cls.includes('wf-progress-dialog') && cls.includes('mdc-dialog--open'))
          dialogOpen = true;
        for (const c of node.children || []) checkDialog(c);
        for (const s of node.shadowRoots || []) checkDialog(s);
        if (node.contentDocument) checkDialog(node.contentDocument);
      }
      checkDialog(root);
      if (!dialogOpen) break;
      await page.waitForTimeout(500);
    }
  }

  async function waitForTableDataToStabilize(timeoutMs = 300000) {
    console.log('    Aguardando estabilização da tabela...');
    const start = Date.now();
    const seletorTabela = 'table.sl-rootTable.sl-sticky[data-sendgrid-hack]';
    let ultimoTotalLinhas = -1;
    let ciclosEstaveis = 0;

    while (Date.now() - start < timeoutMs) {
      const frames = page.frames().filter((frame) => {
        const url = frame.url() || '';
        return url.includes('/wf/data/');
      });

      let encontrouTabela = false;

      for (const frame of frames) {
        const tabela = frame.locator(seletorTabela).first();
        const existeTabela = await tabela.count().catch(() => 0);
        if (!existeTabela) continue;
        encontrouTabela = true;

        const totalLinhas = await tabela.evaluate((tableEl) => {
          return tableEl.querySelectorAll('tbody.sl-content > tr').length;
        }).catch(() => 0);

        if (totalLinhas > 0 && totalLinhas === ultimoTotalLinhas) {
          ciclosEstaveis += 1;
        } else {
          ciclosEstaveis = 0;
          ultimoTotalLinhas = totalLinhas;
        }

        console.log(`    Linhas atuais na tabela: ${totalLinhas} | ciclos estáveis: ${ciclosEstaveis}`);

        if (totalLinhas > 0 && ciclosEstaveis >= 3) {
          console.log(`    Tabela estabilizada com ${totalLinhas} linhas.`);
          return;
        }
      }

      if (!encontrouTabela) {
        ultimoTotalLinhas = -1;
        ciclosEstaveis = 0;
      }

      await page.waitForTimeout(2000);
    }

    console.log('    [AVISO] Tabela não estabilizou antes do timeout; seguindo com a extração.');
  }

  function findById(root, id) {
    if (attrs(root).id === id) return root;
    for (const c of root.children || []) { const r = findById(c, id); if (r) return r; }
    for (const s of root.shadowRoots || []) { const r = findById(s, id); if (r) return r; }
    if (root.contentDocument) { const r = findById(root.contentDocument, id); if (r) return r; }
    return null;
  }

  // Coleta todos os elementos que possuam todas as classes listadas
  function findAllByClasses(root, classes, resultado = []) {
    const cls = attrs(root).class || '';
    if (classes.every(c => cls.includes(c))) resultado.push(root);
    for (const c of root.children || []) findAllByClasses(c, classes, resultado);
    for (const s of root.shadowRoots || []) findAllByClasses(s, classes, resultado);
    if (root.contentDocument) findAllByClasses(root.contentDocument, classes, resultado);
    return resultado;
  }

  async function extrairTabela(timeoutMs = 300000) {
    console.log('    Aguardando tabela aparecer...');
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Busca especificamente a tabela principal do resultado BOM.
      const { result } = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const tableSelectors = [
            'table.sl-rootTable.sl-sticky.sl--initialized[data-sendgrid-hack]',
            'table.sl-rootTable.sl-sticky.sl--initialized',
            'table.sl-rootTable'
          ];

          function collectDocs(win, docs = []) {
            try {
              if (win?.document) docs.push(win.document);
              for (const frame of win?.frames || []) collectDocs(frame, docs);
            } catch (_) {}
            return docs;
          }

          for (const doc of collectDocs(window)) {
            for (const selector of tableSelectors) {
              const table = doc.querySelector(selector);
              if (!table) continue;

              const rows = [...table.querySelectorAll(':scope > tbody.sl-content > tr, :scope > tbody > tr')];
              const data = rows
                .map(row =>
                  [...row.querySelectorAll(':scope > td, :scope > th')]
                    .map(cell => cell.innerText.replace(/\\s+/g, ' ').trim())
                )
                .filter(cols =>
                  cols.length > 0 &&
                  cols.some(Boolean) &&
                  !cols.join(' ').includes('innovaro.com.br') &&
                  !cols.join(' ').includes('/Menu/')
                );

              if (data.length > 0) return data;
            }
          }

          return [];
        })()`,
        returnByValue: true
      });

      const dados = result.value || [];
      if (dados.length > 0) {
        console.log(`    Linhas extraídas: ${dados.length}`);
        return dados;
      }

      await page.waitForTimeout(1000);
    }

    console.log('    [AVISO] Tabela não apareceu após timeout.');
    return [];
  }

  async function extrairTabelaRobusta(timeoutMs = 300000) {
    console.log('    Aguardando tabela aparecer...');
    const start = Date.now();
    let ultimoDiagnostico = 0;
    const seletorTabela = 'table.sl-rootTable.sl-sticky[data-sendgrid-hack]';

    while (Date.now() - start < timeoutMs) {
      const frames = page.frames().filter((frame) => {
        const url = frame.url() || '';
        return url.includes('/wf/data/');
      });

      for (const frame of frames) {
        const tabelas = frame.locator(seletorTabela);
        const totalTabelas = await tabelas.count().catch(() => 0);
        if (!totalTabelas) continue;

        for (let i = 0; i < totalTabelas; i++) {
          const dados = await tabelas.nth(i).evaluate((tableEl) => {
            const linhas = [...tableEl.querySelectorAll('tr')];
            return linhas
              .map((tr) =>
                [...tr.querySelectorAll('th, td')].map((cell, cellIndex) => {
                  let texto = (cell.textContent || '').replace(/\s+/g, ' ').trim();
                  texto = texto.replace(/^arrow_(drop_down|right)\s*/i, '');
                  if (cellIndex === 0) {
                    const pontos = cell.querySelectorAll('.sl-tab, .sl-dot').length;
                    if (pontos > 0) texto = `${'. '.repeat(pontos)}${texto}`;
                  }
                  return texto;
                })
              )
              .filter((cols) =>
                cols.length > 0 &&
                cols.some(Boolean) &&
                !cols.join(' ').includes('innovaro.com.br') &&
                !cols.join(' ').includes('/Menu/')
              );
          }).catch(() => []);

          if (dados.length > 0) {
            console.log(`    Tabela encontrada no frame: ${frame.url() || '[sem URL]'}`);
            console.log(`    Linhas extraídas: ${dados.length}`);
            return dados;
          }
        }
      }

      if (Date.now() - ultimoDiagnostico >= 5000) {
        ultimoDiagnostico = Date.now();
        const resumoFrames = [];
        for (const frame of frames) {
          const qtdRootTables = await frame.locator(seletorTabela).count().catch(() => 0);
          const qtdTables = await frame.locator('table').count().catch(() => 0);
          resumoFrames.push({
            url: frame.url() || '[sem URL]',
            tabelasAlvo: qtdRootTables,
            tables: qtdTables
          });
        }
        console.log(`    Diagnóstico de frames/tabelas: ${JSON.stringify(resumoFrames)}`);
      }

      await page.waitForTimeout(1000);
    }

    console.log('    [AVISO] Tabela não apareceu após timeout.');
    return [];
  }

  async function logarElementosPaginaCompletos(tag = 'extracao') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseDir = path.join('C:\\bom_cemag', 'logs_dom', `${stamp}_${tag}`);
    fs.mkdirSync(baseDir, { recursive: true });

    const frames = page.frames();
    const resumo = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const payload = await frame.evaluate(() => {
        const todos = [...document.querySelectorAll('*')].map((el) => ({
          tag: el.tagName,
          id: el.id || '',
          class: el.className || '',
          name: el.getAttribute('name') || '',
          text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          outerHTML: (el.outerHTML || '').slice(0, 2000)
        }));

        return {
          url: location.href,
          title: document.title,
          html: document.documentElement ? document.documentElement.outerHTML : '',
          elementos: todos
        };
      }).catch((err) => ({
        url: frame.url() || '',
        title: '',
        html: '',
        elementos: [],
        erro: String(err)
      }));

      const htmlPath = path.join(baseDir, `frame_${i}.html`);
      const jsonPath = path.join(baseDir, `frame_${i}_elementos.json`);

      fs.writeFileSync(htmlPath, payload.html || '', 'utf8');
      fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

      resumo.push({
        frame: i,
        url: payload.url || frame.url() || '[sem URL]',
        elementos: payload.elementos ? payload.elementos.length : 0,
        erro: payload.erro || ''
      });
    }

    const resumoPath = path.join(baseDir, 'resumo.json');
    fs.writeFileSync(resumoPath, JSON.stringify(resumo, null, 2), 'utf8');
    console.log(`    DOM completo salvo em: ${baseDir}`);
    console.log(`    Resumo dos frames: ${JSON.stringify(resumo)}`);
  }

  async function preencherCamposFixos(recursosValor) {
    // Classe Recursos = Recursos
    await fillField('classeRecursos', 'Recursos');
    await page.keyboard.press('Tab');
    await handlePopupIfOpen();

    // Recursos = chaves do lote coladas (evita trigger de lookup por caractere)
    await pasteField('recursos', recursosValor);
    await page.keyboard.press('Tab');
    await handleRecursosPopup();

    // Lotes = vazio
    await clearField('lotes');

    // Nível de Explosão = 20
    await fillField('nivelDeExplosao', '20');

    // Quantidade a Compor = 1
    await fillField('quantidadeACompor', '1');

    // Checkboxes Apresentação:
    // 0-3 marcados, 4 Mostrar como Árvore desmarcado, 5 Composição Invertida desmarcado
    {
      const root = await dom();
      const cbs = allCheckboxes(root).slice(0, 13);
      for (let i = 0; i < 6; i++) {
        const deveMarcado = ![4, 5].includes(i);
        const estaMarcado = cbs[i].icon === 'check_box';
        if (deveMarcado !== estaMarcado) {
          await clickNode(cbs[i].nodeId);
          await page.waitForTimeout(300);
        }
      }
    }

    // Nível expansão em árvore = vazio
    await clearField('nivelExpansaoArvore');

    // Classes de Pedido = vazio
    await clearField('classesDePedido');

    // Mostra Custos = Custo Médio
    await fillField('mostraCustos', 'Custo Médio');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);

    // Data Base = 31/12/2026
    await fillField('dataBase', '31/12/2026');

    // Local Escrituracao = Matriz
    await fillField('localEscrituracao', 'Matriz');
    const arrowId = lookupBtn(await dom(), 'localEscrituracao');
    await clickNode(arrowId);
    await page.waitForTimeout(1500);
    {
      const root = await dom();
      const cbs = allCheckboxes(root);
      const popupCbs = cbs.slice(13);
      if (popupCbs.length > 0 && popupCbs[0].icon === 'check_box_outline_blank') {
        await clickNode(popupCbs[0].nodeId);
        await page.waitForTimeout(400);
      }
      const ok = findBtnByText(await dom(), 'Ok');
      if (ok) { await clickNode(ok); await page.waitForTimeout(800); }
    }

    // Checkboxes Exibir Colunas (índices 6-12, todos marcados)
    {
      const root = await dom();
      const cbs = allCheckboxes(root).slice(0, 13);
      for (let i = 6; i <= 12; i++) {
        if (cbs[i].icon !== 'check_box') {
          await clickNode(cbs[i].nodeId);
          await page.waitForTimeout(300);
        }
      }
    }
  }

  // ── PASSO 1: Login ───────────────────────────────────────────────────────────

  async function fazerLoginSeNecessario() {
    const loginRoot = await dom();
    const unId = findByName(loginRoot, 'username');
    if (!unId) return;

    console.log('[1/3] Fazendo login...');
    await client.send('DOM.focus', { nodeId: unId });
    await page.keyboard.type('ti_admin', { delay: 50 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await page.keyboard.type('Cem@#1616', { delay: 50 });
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);
  }

  async function abrirBomCemag({ pularConsultasGerenciais = false } = {}) {
    await page.goto('http://192.168.3.140/sistema');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2500);

    await fazerLoginSeNecessario();

    console.log('[2/3] Navegando para BOM CEMAG...');
    await page.click('button[aria-label="Menu"]');
    await page.waitForTimeout(2000);
    await page.click('text=Produção');
    await page.waitForTimeout(1500);
    if (!pularConsultasGerenciais) {
      await page.click('text=Consultas gerenciais');
      await page.waitForTimeout(1500);
    }
    await page.click('text=Processos e composição de recursos com custos (BOM) CEMAG', { timeout: 60000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);
  }

  await abrirBomCemag();

  /*
  console.log('[1/3] Fazendo login...');
  const loginRoot = await dom();
  const unId = findByName(loginRoot, 'username');
  await client.send('DOM.focus', { nodeId: unId });
  await page.keyboard.type('ti_admin', { delay: 50 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  await page.keyboard.type('Cem@#1616', { delay: 50 });
  await page.keyboard.press('Enter');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);

  // ── PASSO 2: Navegar até BOM CEMAG ──────────────────────────────────────────

  console.log('[2/3] Navegando para BOM CEMAG...');
  await page.click('button[aria-label="Menu"]');
  await page.waitForTimeout(1000);
  await page.click('text=Produção');
  await page.waitForTimeout(600);
  await page.click('text=Consultas gerenciais');
  await page.waitForTimeout(600);
  await page.click('text=Processos e composição de recursos com custos (BOM) CEMAG');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);

  // ── PASSO 3: Processar em lotes de 100 ──────────────────────────────────────

  */

  const listaParaProcessar = MODO_TESTE ? listaChaves.slice(0, TESTE_SIZE) : listaChaves;
  const totalLotes = Math.ceil(listaParaProcessar.length / BATCH_SIZE);
  if (MODO_TESTE) console.log(`[MODO TESTE] Processando apenas ${TESTE_SIZE} chaves.`);
  console.log(`[3/3] Processando ${listaParaProcessar.length} chaves em ${totalLotes} lote(s) de ${BATCH_SIZE}...`);

  const lista_dados = [];

  for (let i = 0; i < listaParaProcessar.length; i += BATCH_SIZE) {
    const lote = listaParaProcessar.slice(i, i + BATCH_SIZE);
    const loteNum = Math.floor(i / BATCH_SIZE) + 1;
    if (MAX_LOTES && loteNum > MAX_LOTES) {
      console.log(`Limite configurado atingido: encerrando após ${MAX_LOTES} lote(s).`);
      break;
    }
    console.log(`  Lote ${loteNum}/${totalLotes} — ${lote.length} chaves`);

    if (loteNum > 1) {
      console.log(`    Reiniciando tela do BOM para o lote ${loteNum}...`);
      await abrirBomCemag({ pularConsultasGerenciais: true });
    }

    // Preencher campos fixos + recursos do lote
    await preencherCamposFixos(lote.join(';'));

    // Clicar em Executar
    const execRoot = await dom();
    let execNodeId = null;
    function findExec(node) {
      if (node.nodeName === 'BUTTON' || node.nodeName === 'A') {
        const txt = (node.children || []).map(c => c.nodeValue || c.children?.[0]?.nodeValue || '').join('').trim();
        if (txt === 'Executar') { execNodeId = node.nodeId; return; }
      }
      for (const c of node.children || []) findExec(c);
      for (const s of node.shadowRoots || []) findExec(s);
      if (node.contentDocument) findExec(node.contentDocument);
    }
    findExec(execRoot);

    if (execNodeId) {
      await clickNode(execNodeId);
    } else {
      await page.click('text=Executar');
    }

    console.log(`    Executar clicado. Aguardando carregamento...`);
    await waitForLoadingToFinish();
    await waitForTableDataToStabilize();

    await logarElementosPaginaCompletos(`lote_${loteNum}`);

    // Extrair tabela de resultados
    const dadosLote = await extrairTabelaRobusta();
    lista_dados.push(...dadosLote);
    console.log(`    Lote ${loteNum} concluído. Total acumulado: ${lista_dados.length} linhas.`);
  }

  console.log(`\nTodos os lotes processados. Total de linhas: ${lista_dados.length}`);

  // ── Aguardar comando antes de salvar ─────────────────────────────────────────
  // Salvar Excel
  if (lista_dados.length > 0) {
    const wb = XLSX.utils.book_new();
    const wsRaw = XLSX.utils.aoa_to_sheet(lista_dados);
    XLSX.utils.book_append_sheet(wb, wsRaw, 'BOM RAW');

    try {
      const dadosTratados = await tratarDadosFinais(lista_dados);
      const wsTratado = XLSX.utils.json_to_sheet(dadosTratados);
      XLSX.utils.book_append_sheet(wb, wsTratado, 'BOM TRATADO');
      console.log(`Tratamento final concluído. Linhas tratadas: ${dadosTratados.length}`);
      const syncStats = await syncCarretasFromRows(dadosTratados);
      console.log(`Sync banco: created=${syncStats.created}, updated=${syncStats.updated}, existing_kept=${syncStats.existing_kept}`);
    } catch (error) {
      console.log(`Falha no tratamento final: ${error.message}`);
    }

    const outPath = 'C:\\bom_cemag\\resultado_bom.xlsx';
    XLSX.writeFile(wb, outPath);
    console.log(`Excel salvo em: ${outPath}`);
  } else {
    console.log('Nenhuma linha extraída. Excel não foi gerado.');
  }

  await browser.close();
})();
