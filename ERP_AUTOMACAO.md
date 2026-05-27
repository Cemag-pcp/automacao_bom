# Automação Do ERP Innovaro / BOM CEMAG

Este documento registra como automatizar o ERP usado neste projeto, para reutilização por Codex, Claude ou qualquer outro agente.

## Objetivo

Automatizar a consulta:

- `Produção`
- `Consultas gerenciais`
- `Processos e composição de recursos com custos (BOM) CEMAG`

e então:

- preencher os filtros
- executar a consulta em lotes
- esperar o relatório terminar
- extrair a tabela correta
- tratar os dados
- opcionalmente sincronizar com o banco

## Arquivos principais

- [bom_cemag.js](/abs/path/C:/bom_cemag/bom_cemag.js)
- [diag_tabela.js](/abs/path/C:/bom_cemag/diag_tabela.js)
- [ERP_AUTOMACAO.md](/abs/path/C:/bom_cemag/ERP_AUTOMACAO.md)

## Premissas do ERP

- A aplicação principal abre em `http://192.168.3.140/sistema`
- A consulta BOM renderiza o resultado em um `frame` com URL contendo `/wf/data/`
- A tabela do relatório é uma tabela HTML real
- O seletor validado em produção foi:

```css
table.sl-rootTable.sl-sticky[data-sendgrid-hack]
```

## Estratégia técnica

O ERP não é estável o suficiente para depender só de seletores Playwright simples em todos os campos.

Por isso a automação usa dois mecanismos:

- Playwright para navegação de alto nível
- CDP (`context.newCDPSession(page)`) para:
  - localizar `input` por `name`
  - focar campos com `DOM.focus`
  - clicar por coordenada com `DOM.getBoxModel`
  - operar através de shadow DOM / estrutura interna do framework

## Fluxo de navegação

### 1. Abrir a tela principal

Abrir:

```text
http://192.168.3.140/sistema
```

Esperar:

- `networkidle`
- alguns `waitForTimeout(...)` extras

Isso é necessário porque o ERP continua montando interface mesmo após o `networkidle`.

### 2. Login

O login é considerado necessário quando existe um `input[name="username"]`.

Se existir:

- focar o campo via CDP
- preencher usuário
- tab
- preencher senha
- enter

Se não existir:

- a sessão ainda está válida
- não tentar logar novamente

Função usada:

- `fazerLoginSeNecessario()`

### 3. Navegar pelo menu

Fluxo base:

1. clicar no botão `Menu`
2. clicar em `Produção`
3. clicar em `Consultas gerenciais`
4. clicar em `Processos e composição de recursos com custos (BOM) CEMAG`

Observação importante:

- no primeiro ciclo abre `Consultas gerenciais`
- nos ciclos seguintes o menu já pode estar expandido
- por isso a função `abrirBomCemag({ pularConsultasGerenciais: true })` existe

## Preenchimento dos campos

Os campos são encontrados por `name`, não por label visual.

Helpers principais:

- `fillField(name, value)`
- `pasteField(name, value)`
- `clearField(name)`

### Motivo do `pasteField`

O campo `recursos` não deve ser digitado caractere por caractere, porque isso dispara comportamento de lookup no meio da digitação.

Então a estratégia correta é:

- focar
- `Ctrl+A`
- `Input.insertText`

## Campos já mapeados

Estes campos já foram automatizados:

- `classeRecursos`
- `recursos`
- `lotes`
- `nivelDeExplosao`
- `quantidadeACompor`
- `nivelExpansaoArvore`
- `classesDePedido`
- `mostraCustos`
- `dataBase`
- `localEscrituracao`

## Popups e lookups

O ERP abre popups de seleção em alguns campos.

### Popup simples

Estratégia:

- esperar
- encontrar checkboxes do popup
- marcar a primeira
- clicar em `Ok`

Função:

- `handlePopupIfOpen()`

### Popup de múltiplos recursos

Estratégia:

- esperar aparecer o botão `Todos`
- clicar em `Todos`
- clicar em `Ok`

Função:

- `handleRecursosPopup()`

## Checkboxes do relatório

A automação usa os checkboxes já localizados no DOM do formulário.

Regras importantes hoje:

- `Mostrar como Árvore`: desmarcado
- `Composição Invertida`: desmarcado
- `nivelExpansaoArvore`: vazio

Não assumir a ordem sem validar.

Hoje o script usa os primeiros checkboxes da tela e controla por índice.

Se o ERP mudar layout, essa parte deve ser revalidada.

## Execução do relatório

Depois de preencher:

- encontrar botão/link `Executar`
- clicar

O clique é feito preferencialmente via CDP / box model quando o nó é localizado.

Fallback:

- `page.click('text=Executar')`

## Como esperar o processamento terminar

Esse é o ponto mais crítico.

Não basta esperar a tabela aparecer.

O fluxo correto é:

1. `waitForLoadingToFinish()`
2. `waitForTableDataToStabilize()`
3. `extrairTabelaRobusta()`

### 1. waitForLoadingToFinish

Observa se existe diálogo com classes:

- `wf-progress-dialog`
- `mdc-dialog--open`

Enquanto existir, ainda está processando.

### 2. waitForTableDataToStabilize

Mesmo depois do diálogo sumir, o ERP pode continuar populando a tabela.

Por isso a automação:

- procura a tabela do relatório no frame `/wf/data/`
- conta `tbody.sl-content > tr`
- exige que a contagem fique igual por alguns ciclos seguidos

Isso evita extrair quando a tela ainda mostra 60% de progresso.

### 3. extrairTabelaRobusta

Só depois da estabilização a extração é liberada.

## Extração da tabela

### Frame correto

O resultado não está no documento principal.

Está em `page.frames()` com URL contendo:

```text
/wf/data/
```

### Seletor validado

```css
table.sl-rootTable.sl-sticky[data-sendgrid-hack]
```

### Estratégia de extração

Para cada linha:

- iterar `tr`
- ler `th, td`
- limpar texto
- remover ícones `arrow_drop_down` / `arrow_right`
- reconstruir hierarquia do primeiro campo usando:
  - `.sl-tab`
  - `.sl-dot`

O primeiro campo recebe prefixo em pontos, por exemplo:

```text
. . 030340LC - PLATAFORMA LARANJA ...
```

Isso é importante porque o tratamento posterior depende de:

- `NUMERO DE PONTOS`
- detecção de conjunto
- produto pai

## Reinício entre lotes

Não reutilizar a tela do relatório para o próximo lote.

A regra correta é:

- do lote 2 em diante, reabrir o ERP na tela principal
- navegar novamente até a consulta BOM
- preencher tudo de novo

Motivo:

- o relatório muda o DOM
- campos do formulário deixam de existir
- reaproveitar a mesma tela gera falhas como `DOM.focus: Invalid parameters`

## Diagnóstico e inspeção

### Dump completo do DOM

Função:

- `logarElementosPaginaCompletos(tag)`

Gera em `logs_dom/`:

- HTML completo por frame
- JSON com elementos
- resumo dos frames

Usar isso quando:

- a tabela não for encontrada
- o seletor parecer certo mas a extração falhar
- houver suspeita de mudança de tela

### Script de diagnóstico

Arquivo:

- [diag_tabela.js](/abs/path/C:/bom_cemag/diag_tabela.js)

Serve para:

- abrir a tela
- executar um caso curto
- inspecionar a presença da tabela e elementos relevantes

## Tratamento dos dados

Depois da extração crua:

- gerar aba `BOM RAW`
- processar a estrutura
- gerar aba `BOM TRATADO`

O tratamento já implementado inclui:

- `DESCRIÇÃO`
- `CODIGO`
- `NUMERO DE PONTOS`
- `PRIMEIRO PROCESSO`
- `MATÉRIA PRIMA`
- `CONJUNTO`
- `2 PROCESSO`
- `PRODUTO`
- `PESO`
- merge com planilha de apontamento
- classificação de células/grupos

## Integração com Google Sheets

O script usa credenciais no `.env` de `service_account`.

A planilha consultada hoje é:

- planilha: `1x26yfwoF7peeb59yJuJuxCQNlqjCjh65NYS1RIrC0Zc`
- aba: `RQ PCP 002-000 (APONTAMENTO MONTAGEM)`

Uso:

- preencher `CELULA 1`
- preencher `CELULA 2`
- derivar `CELULA 3`

## Integração com banco

### ItensExplodidos

Na montagem da lista final, além das chaves vindas do catálogo de produtos, o script também busca:

- `produto` em `cadastro_itensexplodidos`

Hoje essa consulta usa o schema:

- `BASE_TESTE`

### Upsert de CarretasExplodidas

Após gerar `BOM TRATADO`, o script faz upsert em:

- `cadastro_carretasexplodidas`

Chave natural:

- `codigo_peca`
- `carreta`
- `conjunto_peca`

Hoje o comportamento é:

- inserir ausentes
- atualizar existentes
- não deletar

## Modos de execução

### Automação completa

```powershell
node .\bom_cemag.js
```

### Execução de teste

```powershell
node .\bom_cemag.js --teste
```

### Somente tratamento

```powershell
node .\bom_cemag.js --tratar-only
```

Esse modo:

- não abre navegador
- lê `resultado_bom.xlsx`
- usa `BOM RAW` se existir
- gera `BOM TRATADO`
- sincroniza com o banco

## Regras operacionais para futuras automações no ERP

- Preferir `name` de input, não label visual
- Assumir que haverá shadow DOM / estrutura encapsulada
- Usar CDP para foco e clique quando Playwright puro falhar
- Não confiar só em `networkidle`
- Não confiar só no desaparecimento do loading
- Não confiar só na existência da tabela
- Sempre considerar frame `/wf/data/`
- Reabrir a consulta entre lotes
- Registrar dump de DOM quando algo “parece certo” mas falha
- Validar se o menu em árvore ficou expandido ou não entre ciclos

## Checklist para uma nova automação no mesmo ERP

1. Descobrir a URL principal e a tela final
2. Confirmar se o conteúdo final cai em `/wf/data/`
3. Mapear campos por `name`
4. Descobrir se há lookup/popup por campo
5. Descobrir como o loading é representado no DOM
6. Descobrir seletor real da tabela
7. Validar se a tabela aparece antes de estar completa
8. Implementar estabilização por contagem de linhas
9. Implementar dump de DOM para diagnóstico
10. Só então adicionar tratamento e sync

## Observações finais

- O ERP é sensível a tempo e estado de tela
- Pequenas mudanças de layout quebram automações baseadas em índice
- Sempre preferir documentação do comportamento real observável sobre suposições
- Se a extração voltar a falhar, a primeira ação deve ser gerar novo dump em `logs_dom/` e conferir o frame `/wf/data/`
