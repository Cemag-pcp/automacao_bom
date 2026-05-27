// diag_tabela.js — inspeciona o DOM após executar BOM com 1 item
// Uso: node diag_tabela.js
// Abre o browser, faz login, navega até BOM CEMAG, executa com 1 chave teste
// e loga todos os IDs + nomes de elementos encontrados via CDP (pierce shadow DOM)

const { chromium } = require('playwright');

const CHAVE_TESTE = '60504309'; // CBHM5000 GR SS RD M17

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto('http://192.168.3.140/sistema');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const client = await context.newCDPSession(page);

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

  // Coleta todos os IDs e tags relevantes (table, tbody, list, grid, wf-*)
  function dumpDom(root, out = []) {
    const id = (attrs(root).id || '').trim();
    const cls = (attrs(root).class || '').trim();
    const tag = root.nodeName;
    const relevante = id ||
      ['TABLE','TBODY','THEAD','TR','TD','TH','UL','LI'].includes(tag) ||
      cls.includes('wf-') || cls.includes('list') || cls.includes('grid') || cls.includes('result');
    if (relevante) {
      out.push({ tag, id: id || '—', class: cls.substring(0, 80) || '—' });
    }
    for (const c of root.children || []) dumpDom(c, out);
    for (const s of root.shadowRoots || []) dumpDom(s, out);
    if (root.contentDocument) dumpDom(root.contentDocument, out);
    return out;
  }

  // ── Login ────────────────────────────────────────────────────────────────────
  console.log('Fazendo login...');
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

  // ── Navegação ────────────────────────────────────────────────────────────────
  console.log('Navegando para BOM CEMAG...');
  await page.click('button[aria-label="Menu"]');
  await page.waitForTimeout(2000);
  await page.click('text=Produção');
  await page.waitForTimeout(1500);
  await page.click('text=Consultas gerenciais');
  await page.waitForTimeout(1500);
  await page.click('text=Processos e composição de recursos com custos (BOM) CEMAG', { timeout: 60000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  // ── Preencher Recursos direto (1 chave) ──────────────────────────────────────
  console.log(`Preenchendo recursos com chave ${CHAVE_TESTE}...`);

  // Classe Recursos
  {
    const id = findByName(await dom(), 'classeRecursos');
    await client.send('DOM.focus', { nodeId: id });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Recursos', { delay: 50 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(900);
    // Fecha popup se abrir
    const root = await dom();
    const cbs = [];
    function walkCb(n) {
      if (n.nodeName === 'BUTTON' && (attrs(n).class || '').includes('wf-checkbox'))
        cbs.push(n.nodeId);
      for (const c of n.children || []) walkCb(c);
      for (const s of n.shadowRoots || []) walkCb(s);
      if (n.contentDocument) walkCb(n.contentDocument);
    }
    walkCb(root);
    if (cbs.length > 13) {
      await clickNode(cbs[13]);
      await page.waitForTimeout(400);
      const ok = findBtnByText(await dom(), 'Ok');
      if (ok) { await clickNode(ok); await page.waitForTimeout(800); }
    }
  }

  // Recursos
  {
    const id = findByName(await dom(), 'recursos');
    await client.send('DOM.focus', { nodeId: id });
    await page.keyboard.press('Control+A');
    await client.send('Input.insertText', { text: CHAVE_TESTE });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(2000);
    // Popup "Todos"
    const start2 = Date.now();
    while (Date.now() - start2 < 15000) {
      const todos = findBtnByText(await dom(), 'Todos');
      if (todos) {
        await clickNode(todos);
        await page.waitForTimeout(400);
        const ok = findBtnByText(await dom(), 'Ok');
        if (ok) { await clickNode(ok); await page.waitForTimeout(800); }
        break;
      }
      await page.waitForTimeout(500);
    }
  }

  // ── Executar ─────────────────────────────────────────────────────────────────
  console.log('Clicando Executar...');
  {
    const root = await dom();
    let execId = null;
    function findExec(n) {
      if (n.nodeName === 'BUTTON' || n.nodeName === 'A') {
        const txt = (n.children || []).map(c => c.nodeValue || c.children?.[0]?.nodeValue || '').join('').trim();
        if (txt === 'Executar') { execId = n.nodeId; return; }
      }
      for (const c of n.children || []) findExec(c);
      for (const s of n.shadowRoots || []) findExec(s);
      if (n.contentDocument) findExec(n.contentDocument);
    }
    findExec(root);
    if (execId) await clickNode(execId); else await page.click('text=Executar');
  }

  // ── Aguardar loading ─────────────────────────────────────────────────────────
  console.log('Aguardando loading...');
  await page.waitForTimeout(3000);
  const startWait = Date.now();
  while (Date.now() - startWait < 120000) {
    const root = await dom();
    let open = false;
    function chkDlg(n) {
      const cls = attrs(n).class || '';
      if (cls.includes('wf-progress-dialog') && cls.includes('mdc-dialog--open')) open = true;
      for (const c of n.children || []) chkDlg(c);
      for (const s of n.shadowRoots || []) chkDlg(s);
      if (n.contentDocument) chkDlg(n.contentDocument);
    }
    chkDlg(root);
    if (!open) break;
    await page.waitForTimeout(500);
  }

  // ── Dump do DOM ──────────────────────────────────────────────────────────────
  console.log('\n===== DUMP DO DOM (IDs + elementos relevantes) =====');
  const root = await dom();
  const items = dumpDom(root);
  for (const item of items) {
    console.log(`  ${item.tag.padEnd(10)} id="${item.id}"  class="${item.class}"`);
  }
  console.log('===== FIM DO DUMP =====\n');

  console.log('Inspecione o output acima para identificar o elemento da tabela.');
  console.log('Browser aberto para inspeção visual. Pressione Ctrl+C para sair.');
})();
