# Pesquisa v2 — orquestração (fixes + funcionalidades novas)

Plano para uma sessão **orquestradora** que lança subagentes **Sonnet 5.5 com effort `high`**,
integra o trabalho, verifica tudo e abre os PRs no GitHub. Segue a disciplina que construiu o
Rubrica (`agents/README.md`): **contrato primeiro, posse exclusiva de ficheiros, ondas**.

Duas fases, dois PRs:

| Fase | Objetivo | PR |
|---|---|---|
| **1** | Corrigir as falhas atuais da pesquisa | `fix(search): …` → `main` |
| **2** | Proximidade, âmbito (capítulo / intervalo de páginas), mapa de densidade, excluir cabeçalhos/rodapés, ignorar acentos | `feat(search): …` → `main` |

A fase 2 só começa depois de o PR da fase 1 estar **merged** em `main` (ou, se o utilizador
pedir para não esperar, empilhada: branch a partir de `search/phase-1`, PR com base nessa branch).

---

## 0. Como lançar

Numa sessão nova (Opus), na raiz do repo, em `main` atualizado:

> Lê `agents/SEARCH-ORCHESTRATION.md` e executa a **Fase 1** como orquestrador. Lê também
> `agents/CONTRACTS.md`, `docs/ARCHITECTURE.md` e `src-tauri/API.md` antes de começar.

(Depois do merge: o mesmo pedido com **Fase 2**.)

### Regras do orquestrador

- Subagentes lançados com a ferramenta `Agent`: `model: "sonnet"`, `effort: "high"`,
  `isolation: "worktree"`. Agentes independentes da mesma onda vão **na mesma mensagem**
  (correm em paralelo).
- Cada brief de subagente leva: a secção deste ficheiro que lhe cabe, as secções relevantes de
  `CONTRACTS.md`, a lista **explícita** de ficheiros que possui e os que não pode tocar, e os
  comandos de verificação (§4). Dois subagentes nunca partilham um ficheiro.
- Os subagentes **não fazem push nem abrem PRs**. Fazem commit na sua branch de worktree
  (Conventional Commits) e escrevem um relatório em `agents/reports/<id>-report.md`.
- O orquestrador é o **único** que altera ficheiros partilhados (contrato, `types.rs`,
  `lib.rs`, `bindings.ts`, mock, locales). Estes ficam congelados depois do passo de contrato.
  Um subagente que descubra um problema no contrato para essa parte, regista-o no relatório e
  continua com o resto.
- O orquestrador revê o diff de cada subagente (não confia no relatório), faz merge das
  branches para a branch da fase, corre a verificação completa (§4) e só depois faz push e abre
  o PR.
- Uma falha de verificação volta ao subagente dono do ficheiro (`SendMessage` para o mesmo
  agente, que mantém o contexto), não é corrigida "por cima" pelo orquestrador, exceto
  correções triviais de integração (que ficam anotadas no PR).

---

## 1. Fase 1 — corrigir as falhas atuais

### 1.1 Falhas identificadas (suspeitas; cada uma tem de ser provada com um teste que falha)

Lidas no código em `src/viewer/search/*` e `src-tauri/src/{commands,engine}/text.rs`:

| # | Falha | Onde |
|---|---|---|
| B1 | **Resultados perdidos (race)**: o motor começa a emitir `search_batch` logo no `spawn_blocking`, mas o frontend só define `searchId` depois do `await textSearchStart`. Os batches que chegam antes são descartados por `addBatch` (`searchId !== state.searchId`). Nas primeiras páginas podem desaparecer resultados. Correção: o `searchId` passa a ser gerado pelo cliente (contrato v1.1.0). | `SearchPanel.tsx`, `searchStore.ts` |
| B2 | **Contagem errada**: uma ocorrência que quebra de linha devolve vários retângulos (um por segmento), e cada retângulo conta como um resultado. "3 de 156" pode corresponder a 120 ocorrências reais, e o "seguinte" salta para metade de uma palavra. | `engine/text.rs::search_page`, `searchStore.ts` |
| B3 | **Pesquisa não é cancelada ao fechar**: `close()` não chama `textSearchCancel` e o timer de debounce não é limpo ao fechar ou desmontar. Uma pesquisa "fantasma" pode correr até ao fim num documento de 500 páginas. | `SearchPanel.tsx` |
| B4 | **Resultados obsoletos depois de editar**: depois de uma mutação (redact, edição de texto, reordenar ou rodar páginas), os retângulos antigos continuam desenhados. Não há nova pesquisa quando o `revision` muda. | `SearchPanel.tsx` |
| B5 | **Scroll só até à página**: `scrollToPage` não traz o retângulo ativo para o ecrã. Com zoom alto, o resultado ativo fica fora da vista. | `SearchPanel.tsx`, `viewer/store` |
| B6 | **Lista inútil e lenta**: cada item diz só "Página N", sem contexto, e a lista não é virtualizada (milhares de `<li>`). `@tanstack/react-virtual` já é dependência do projeto. | `SearchPanel.tsx` |
| B7 | **Identidade do resultado ativo por referência de objeto** (`activeMatch.rect === rect`): parte quando os batches são reconstruídos. Deve usar índices. | `SearchHighlights.tsx` |
| B8 | **Teclado incompleto**: não há Shift+Enter (anterior), Esc (fechar e cancelar), F3/Shift+F3, nem Ctrl+Shift+F (expandir para o painel acoplado, B12). Ctrl+F com o painel já aberto deve focar o campo e selecionar o texto. Confirmar que não há colisões (`src/chrome/shortcuts.collisions.test.tsx`). | `SearchPanel.tsx` |
| B9 | **Mudar de separador fecha a pesquisa** e perde a query. Deve guardar o estado por documento. | `searchStore.ts` |
| B10 | **Sem progresso**: num documento longo, "A procurar…" sem indicação de quantas páginas já foram processadas. | `run_search`, `SearchPanel.tsx` |
| B11 | **Verificar**: retângulos corretos em páginas rodadas e com CropBox ≠ MediaBox. | `engine/text.rs` |
| B12 | **O painel tapa a página**: é flutuante (`absolute right-4 top-4`, 320px) por cima da área onde estão os resultados. Passa a barra compacta + painel acoplado à direita (ver §2.1 "Onde vive a pesquisa" e o mockup). S2 pode tocar no ficheiro de layout do viewer que o orquestrador indicar no brief, e mais ninguém lhe toca nesta onda. | `SearchPanel.tsx` + layout do viewer |

O primeiro passo de cada subagente é **um teste que falha para cada falha que lhe pertence**. As
falhas que não se reproduzam ficam registadas no relatório com a evidência, não são "corrigidas"
às cegas. Falhas novas encontradas pelo caminho entram na tabela do relatório.

### 1.2 Passo F1.0 — contrato v1.1.0 (orquestrador, sequencial)

O orquestrador, sozinho, em `search/phase-1`:

1. `CONTRACTS.md` → **v1.1.0**, secção text:
   - `text_search_start(docId, searchId, query, options)`: o **cliente gera o `searchId`** (UUID)
     e define-o no store **antes** de chamar o comando, o que elimina a race de B1 sem buffers.
     `text_search_cancel(searchId)` mantém-se. `INVALID_ARG` se o `searchId` já estiver em uso.
   - `SearchMatch` passa a ser `{ page: u32, hits: SearchHit[] }`.
   - `SearchHit { rects: Rect[], charStart: u32, charLen: u32, context: { before: string, matched: string, after: string } }`
     (uma ocorrência = um hit, com N retângulos; contexto de ~60 caracteres de cada lado,
     espaços colapsados).
   - `SearchBatch` ganha `pagesSearched: u32` e `pageCount: u32`. O motor emite um batch de
     progresso pelo menos de 25 em 25 páginas, mesmo sem resultados.
   - `SearchBatch` ganha `textless: bool`: no batch `done`, `true` quando **nenhuma** página do
     âmbito tem texto extraível (PDF digitalizado). É o que permite à UI distinguir "sem
     resultados" de "este documento não tem texto pesquisável" (estado F do mockup).
2. `src-tauri/src/types.rs` com os tipos novos, `pnpm bindings:generate` e o mock
   `src/ipc/mock/text.ts` atualizado para a forma nova (agrupamento por hit, contexto,
   progresso, `textless`). Chaves i18n novas em `viewer` (en + pt-PT): progresso, contexto,
   atalhos, barra compacta (expandir, compactar, fechar), painel acoplado (título,
   redimensionar), "sem resultados" e "sem texto pesquisável".
3. Tudo compila e `pnpm test` passa com stubs. Commit `chore(contracts): search v1.1.0`.

### 1.3 Onda F1 — paralelo (2 subagentes)

**S1 — Motor de pesquisa (Rust)**
- Possui: `src-tauri/src/engine/text.rs`, `src-tauri/src/commands/text.rs`,
  `src-tauri/tests/*search*` (novos).
- Não toca: `types.rs`, `lib.rs`, nada em `src/`.
- Faz: B2 (agrupar segmentos por ocorrência: índice de caractere do resultado + contexto via
  `FPDFText_GetSchResultIndex`/`GetSchCount` ou o equivalente em `pdfium-render`), B10
  (batches de progresso), B11 (testes com página rodada e com CropBox). Cancelamento testado.
- Regra crítica: **todo o acesso a PDFium passa por `SessionStore::with_session`** (thread
  única, ver `docs/BACKLOG.md` e a memória sobre PDFium). Nada de PDFium noutras threads.

**S2 — UI de pesquisa (React)**
- Possui: `src/viewer/search/**` (incluindo os testes), `src/viewer/store.ts` +
  `src/viewer/store.test.ts` (scroll até um retângulo para B5, recálculo do "ajustar à largura"
  quando o painel acoplado muda a largura do viewer para B12) e o ficheiro de layout do viewer
  que o orquestrador indicar no brief (B12). Nesta onda mais ninguém toca nestes ficheiros.
- Não toca: `src/ipc/**`, locales (pede chaves ao orquestrador no relatório), `src-tauri/**`.
- Faz: B12 (barra compacta + painel acoplado), B1 (gerar o `searchId` no cliente e defini-lo no
  store antes do `await`, com um teste que emite um batch antes de o comando resolver), B3–B9,
  a UI de B10 (barra ou texto "página X de N") e o estado "sem texto pesquisável" (`textless`).
  Lista virtualizada com contexto (`before` **`matched`** `after`) e número de página.
- Testes Vitest contra o mock para cada falha. Atualizar `e2e/lib/search.mjs` se a estrutura
  da lista mudar: o helper conta `ul li button`, e com virtualização passa a contar o total do
  label "X de N", não os nós do DOM.

### 1.4 F1.3 — integração e PR (orquestrador)

Merge S1 → S2 para `search/phase-1`, verificação completa (§4), entrada no `CHANGELOG.md`, push
e PR para `main` com: a tabela B1–B12 (corrigido / não reproduzido + evidência), as mudanças de
contrato e as capturas antes e depois (PrintWindow).

---

## 2. Fase 2 — funcionalidades novas

### 2.1 Comportamento-alvo (decidido aqui para os agentes não divergirem)

**Onde vive a pesquisa (regra: nunca tapar a página)**
- **Barra compacta** (Ctrl+F): uma linha flutuante no canto superior direito do viewer, por cima
  da margem. Tem campo, contagem, ↑ ↓, botão "expandir" e fechar.
- **Painel acoplado** (botão expandir ou Ctrl+Shift+F): coluna à direita com 370px
  (redimensionável entre 300 e 520). O viewer encolhe e o zoom "ajustar à largura" recalcula.
  Substitui o painel flutuante atual (`absolute right-4 top-4`), que tapa os resultados.
- A app lembra-se do último modo usado. Ao ativar um resultado, o scroll compensa a altura da
  barra compacta.
- Atalhos: Ctrl+F (barra/focar), Ctrl+Shift+F (painel acoplado), Enter/F3 seguinte,
  Shift+Enter/Shift+F3 anterior, Esc fecha e cancela, **Alt+P** alterna Frase/Proximidade.
  Todos entram em `src/chrome/shortcuts.collisions.test.tsx`.

**Campo de pesquisa e modos**
- **Frase** (modo por omissão, igual ao comportamento atual): o texto inteiro é procurado como
  uma sequência.
- **Proximidade**: o texto é partido em termos por espaços; `"…"` agrupa uma frase exata como um
  só termo; `-termo` exclui. Um resultado é uma **janela** onde todos os termos aparecem em ≤ N caracteres.
  Por omissão, N = 500 caracteres, configurável no painel (§5).
  A janela pode **atravessar páginas** (fim da página k + início
  da k+1) e **quebras de linha com hífen** ("contra-\nto" encontra "contrato").
- O comprimento da janela conta o texto entre o primeiro e o último termo. Com "excluir
  cabeçalhos e rodapés" ligado, o texto excluído não conta (o rodapé da página k e o cabeçalho
  da k+1 desaparecem). Com a opção desligada, conta.
- Uma janela tem de ficar **inteiramente dentro do âmbito**. No âmbito `[a, b]`, uma janela que
  comece em `b` não pode continuar em `b+1`.
- Resultados de proximidade **ordenados por compacidade** (janela mais curta primeiro), com
  alternância "ordenar por posição". Destaque: uma cor por termo e um retângulo suave à volta da
  janela inteira.
- Um termo excluído invalida a janela se aparecer dentro dela.

**Âmbito**
- Seletor: *Documento inteiro* · *Capítulo atual* · *Capítulo…* (árvore do índice) ·
  *Páginas X–Y* (1-based na UI, 0-based no IPC).
- Capítulo = entrada do índice (bookmarks) → intervalo de páginas `[página da entrada, página da
  próxima entrada do mesmo nível ou superior − 1]`. "Capítulo atual" = a entrada de **nível
  superior** (profundidade 0) que contém a página visível. Um subcapítulo escolhe-se em
  *Capítulo…*. (O painel Índice destaca a entrada mais profunda, porque serve para navegar.)
- Se o PDF não tiver índice, as opções de capítulo ficam desativadas com tooltip explicativo, e
  o intervalo de páginas continua disponível.
- Painel lateral **Índice** (navegável) no viewer, porque o índice faz falta por si só.

**Cores do destaque (editáveis)**
- 4 cores por posição de termo (cor 1 = 1.º termo, …). O modo Frase usa a cor 1.
- O utilizador muda-as clicando na cor de uma etiqueta: abre uma paleta com 8 predefinições, um
  hex livre, pré-visualização e "Repor cores originais". As mesmas opções aparecem em
  **Definições → Pesquisa**.
- A cor fica associada à posição, não à palavra. A opacidade é fixa (~50 %) para a página
  continuar legível. Fica guardada em `search.highlightColors` via `prefs_get`/`prefs_set`
  (mesmo padrão de `src/chrome/prefsStore.ts`). O mapa de densidade continua em accent.
- Responsável: S6. O ficheiro do ecrã de Definições é indicado pelo orquestrador no brief, e
  nenhum outro agente lhe toca nesta onda.

**Normalização**
- **Ignorar acentos**: alternância, **ligada por omissão** ("acao" encontra "ação" e vice-versa).
  Também normaliza ligaduras (ﬁ → fi), aspas curvas e NBSP.
- **Hífens de quebra de linha** (independente da alternância): o hífen suave (U+00AD) é sempre
  removido. Um hífen normal no fim de linha é ambíguo ("contra-\nto" é uma palavra partida,
  "pré-\naviso" é uma palavra composta), por isso a correspondência aceita **as duas formas**:
  "contrato" e "pré-aviso" encontram ambos, e "contra-to" e "préaviso" também.
- Maiúsculas/minúsculas e palavra inteira mantêm-se.

**Excluir cabeçalhos e rodapés**
- Opção da pesquisa, desligada por omissão (§5). Deteção: linhas na faixa superior/inferior (~8 % da altura)
  cuja forma normalizada (dígitos → `#`, números romanos → `#`) se repete em ≥ 30 % das páginas
  (mínimo 3), com tolerância de posição. Funciona em páginas pares/ímpares com cabeçalhos
  diferentes.

**Mapa de densidade**
- Faixa vertical estreita junto à barra de scroll do viewer, visível quando há resultados. Um
  bucket por página (ou agrupado, em documentos longos) com intensidade em escala logarítmica do
  número de hits. Marcador do resultado ativo, marcas finas nas fronteiras dos capítulos (se
  houver índice) e a página visível. O mapa usa os hits **do âmbito** (fora dele não há
  buckets). Clicar salta para essa zona e o hover mostra "p. 16–17 · 4 zonas · 3.2 Por
  incumprimento" ("resultados" em vez de "zonas" no modo Frase; sem capítulo se não houver
  índice). Acessível: `role="img"` com descrição, mais uma alternativa no teclado (não depende
  só da cor).

**Lista de resultados**
- Agrupada pela entrada mais profunda do índice (`outlineItemId`, ex.: "3.2 Por incumprimento ·
  3"), colapsável, com contexto e virtualizada (herdado da fase 1). Sem índice, a lista é plana.
- Ordenação com grupos: em *Por posição*, grupos e hits por ordem do documento. Em *Mais
  compactas*, os hits ordenam-se por compacidade **dentro** de cada grupo, e os grupos ordenam-se
  pelo seu hit mais compacto. "X de N" e ↑/↓ seguem a ordem visível da lista.

### 2.2 Arquitetura do motor

A pesquisa deixa de usar `FPDFText_Find*` e passa a usar um **índice de texto próprio**:

- `engine/search/index.rs`: por página, texto Unicode + caixa de cada caractere + texto
  normalizado com **mapa normalizado → índice original** (para devolver retângulos exatos depois
  de remover acentos, ligaduras ou hífens). Construído de forma lazy, página a página, **na
  thread PDFium** (`with_session`). Fica em cache na sessão, é invalidado por página com os
  `invalidatedPages` de cada `MutationResult` e libertado no `doc_close`.
- A correspondência (frase / proximidade / exclusão / ordenação) é **Rust puro sobre dados já
  extraídos**: corre na task de pesquisa, fora da thread PDFium, sem tocar em PDFium.
- Pipeline do `run_search`: resolver o âmbito para um intervalo de páginas → garantir o índice
  dessas páginas (as janelas não saem do âmbito, §2.1) → filtrar cabeçalhos/rodapés →
  fazer a correspondência → emitir batches em streaming (progresso como na fase 1). Na
  proximidade, a ordenação final por compacidade chega no batch `done` com `ranked: true`; até
  lá, a UI mostra os resultados por posição.

Orçamento de desempenho (medir em `main` antes de começar, com `500-page.pdf` e com a fixture
nova):
- 1.ª pesquisa no documento inteiro ≤ 1,5× o tempo atual.
- Pesquisas seguintes (índice em cache) ≥ 3× mais rápidas que o atual.
- Memória do índice ≤ ~40 MB para 500 páginas densas.

### 2.3 Passo F2.0 — contrato v1.2.0 + fixture (orquestrador, sequencial)

Em `search/phase-2`:

1. **Contrato v1.2.0**:
   - `text_search_start(docId, query: SearchQuery)` substitui `(query, options)`, com
     `SearchQuery { text, mode: 'phrase'|'proximity', proximity?: { window: u32 }, scope: { kind:'all' } | { kind:'pages', from, to } | { kind:'outline', itemId }, caseSensitive, wholeWord, ignoreDiacritics, excludeHeadersFooters }`.
   - `SearchHit` ganha `termIndex` por retângulo (`rects: { rect, term: u8 }[]`), `windowRect?`,
     `score?`, `spansPages?: [u32, u32]`, `outlineItemId?`.
   - `SearchBatch` ganha `ranked: bool` e `furniture: { page: u32, rects: Rect[] }[]`: com
     `excludeHeadersFooters` ligado, os retângulos dos cabeçalhos/rodapés excluídos nas páginas
     desse batch (vazio quando a opção está desligada). A UI usa-os para os esbater e riscar.
   - `outlineItemId` de um hit = a entrada **mais profunda** do índice que contém a página onde
     o hit começa (é a chave de agrupamento da lista).
   - Preferência `search.highlightColors: [string; 4]` (hex `#RRGGBB`, sem alfa) documentada na
     secção de persistência, ao lado das outras chaves de `prefs_get`/`prefs_set`.
   - Comando novo `doc_outline(docId)` → `OutlineItem[]`, com
     `OutlineItem { id, title, page, pageEnd, depth, children }`.
   - `INVALID_ARG` para uma query de proximidade sem termos, um intervalo de páginas inválido ou
     um `itemId` desconhecido.
2. `types.rs`, registo em `lib.rs`, stubs `UNSUPPORTED`, `bindings:generate`, mock completo em
   `src/ipc/mock/text.ts` (+ outline no mock document) e todas as chaves i18n (en + pt-PT).
   Os módulos novos ficam criados vazios (`engine/search/{mod,index,normalize,matcher,furniture}.rs`,
   `engine/outline.rs`) para cada agente só preencher os seus.
   - **Tokens** novos em `src/tokens/tokens.css` (os nomes do mockup): `--search-t1..t4`
     (destaque, ~50 % de opacidade), `--search-t1s..t4s` (cor sólida das etiquetas),
     `--search-active` (contorno âmbar do resultado ativo), `--search-window` e
     `--search-window-line` (retângulo da janela). Os agentes não editam `tokens.css`.
   - **Seletores congelados** em `src/viewer/search/selectors.ts`: as assinaturas que S7 consome
     (contagem de hits por página, página e hit ativos, contagem por `outlineItemId`, se há
     resultados), implementadas como stubs sobre o mock. S6 implementa-os sem mudar as
     assinaturas, e S7 só lê o estado da pesquisa através deles.
3. **Fixture `fixtures/book.pdf`** (em `fixtures/generate.mjs`, determinística): cerca de 40
   páginas, 5 capítulos com subcapítulos e **outline real** (o pdf-lib não tem API de alto
   nível: construir o dicionário `/Outlines` à mão), cabeçalho corrente diferente em páginas
   pares e ímpares, rodapé "Página N de 40", um termo repetido mais de 100 vezes, um trio de
   termos próximos numa só zona conhecida, uma frase partida por mudança de página, uma palavra
   hifenizada na quebra de linha, palavras acentuadas em PT e ligaduras. Mais `book-no-outline.pdf`.
   `fixtures/README.md` documenta as posições esperadas (os testes usam-nas como verdade).
4. Commit `chore(contracts): search v1.2.0 + book fixture`.

### 2.4 Onda F2 — paralelo (5 subagentes)

| Agente | Possui | Entrega |
|---|---|---|
| **S3 — Índice e correspondência** | `engine/search/{index,normalize,matcher}.rs` + testes | Índice por página com mapa de normalização, frase e proximidade (algoritmo da janela mínima com todos os termos, em caracteres, cruzamento de páginas, hífens nas duas formas de §2.1), exclusões, ordenação por compacidade, contexto. Representação compacta para cumprir o orçamento de memória (caixas em `f32`, mapa de normalização em `u32` ou por deltas; a estimativa ingénua de ~4000 car./página × 500 páginas já fica nos 40–50 MB). Testes unitários exaustivos (acentos PT, ligaduras, janela no limite exato de N, termos repetidos, termo excluído, "pré-\naviso" vs "contra-\nto") e property tests se for útil. |
| **S4 — Índice do PDF e âmbito** | `engine/outline.rs`, `commands/outline.rs` (novo, registado no F2.0), resolução de âmbito em `engine/search/mod.rs` | `doc_outline` com `pageEnd` calculado, destinos sem página tratados, ciclos/profundidade protegidos. Resolução scope → intervalo. Testes com `book.pdf` e `book-no-outline.pdf`. |
| **S5 — Cabeçalhos e rodapés** | `engine/search/furniture.rs` + testes | Deteção descrita em §2.1, em cache por documento, invalidada com o índice. Devolve, por página, as linhas excluídas **e os seus retângulos** (para `SearchBatch.furniture`). Testes: `book.pdf` (pares e ímpares), `text.pdf` (sem falsos positivos), `500-page.pdf` ("Page N of 500" é rodapé). |
| **S6 — UI do painel de pesquisa** | `src/viewer/search/**` exceto `DensityMap*` (inclui implementar `selectors.ts` sem mudar as assinaturas), um ficheiro novo `src/viewer/search/searchPrefs.ts` para as preferências da pesquisa, e o ficheiro do ecrã de Definições indicado no brief. Não altera `src/chrome/prefsStore.ts` (segue o padrão, não o edita). | Seletor de modo e janela, seletor de âmbito (com a árvore do índice), alternâncias (acentos, cabeçalhos/rodapés), lista agrupada por capítulo com a ordenação de §2.1, cores por termo editáveis, retângulo da janela e cabeçalhos/rodapés esbatidos (`furniture`) em `SearchHighlights`, Alt+P, preferências persistidas. Contra o mock. Vitest. |
| **S7 — Mapa de densidade e painel Índice** | `src/viewer/search/DensityMap*.tsx`, `src/viewer/outline/**` (novo), o ponto de montagem do mapa no viewer **e** o componente do painel lateral onde o separador "Índice" fica ao lado de "Miniaturas" (o orquestrador indica os dois ficheiros exatos no brief, provavelmente em `src/chrome/`, e mais ninguém lhes toca nesta onda) | Mapa de densidade (§2.1) e painel lateral do índice com navegação. Lê a pesquisa só através de `selectors.ts`. Vitest + teste de acessibilidade. |

O `run_search` em `commands/text.rs` (a pipeline que liga S3+S4+S5) fica para o **orquestrador
no F2.3**. Até lá, cada agente testa o seu módulo isoladamente.

**Ajustes feitos no F2.0** (prevalecem sobre a tabela acima):
- A resolução do âmbito fica em `engine/search/scope.rs` (S4), não em `mod.rs`. O `mod.rs`
  (tipos partilhados `BoxF`, `RawPage`, `TextLine`, `LineText`, `PageLines` e a `SearchCache`
  guardada na sessão) e o `extract.rs` (a única leitura de PDFium da pesquisa) são do
  orquestrador e ficam congelados durante a onda.
- Cada módulo tem assinaturas congeladas no comentário do topo; o resto do desenho interno é
  livre.
- O PDFium devolve o hífen de fim de linha (normal ou suave) como **U+0002**, sem quebra de
  linha; as ligaduras já chegam expandidas ("fi"); o NBSP chega como espaço. Ver
  `agents/reports/f0-fixture-report.md`.
- A fixture tem `fixtures/book.expected.json` com a verdade para os testes.

### 2.5 F2.3 — integração e PR (orquestrador)

1. Merge S3 → S4 → S5 → S6 → S7. Ligar a pipeline em `run_search`.
2. Spec e2e nova `e2e/specs/10-search.e2e.mjs` sobre `book.pdf`: proximidade encontra a zona
   conhecida, o âmbito "capítulo 3" limita os resultados, excluir rodapés retira os
   "Página N de 40", "acao" encontra "ação" e o mapa de densidade aparece.
3. Medir o orçamento de desempenho (§2.2) e pôr os números no PR.
4. Verificação completa (§4), atualizar `CHANGELOG.md`, `src-tauri/API.md` e `README.md`
   (funcionalidades), e marcar no `docs/BACKLOG.md` o que ficou de fora. Push e PR para `main`.

---

## 3. Fora do âmbito (não fazer nestas fases)

Pesquisa semântica/IA, OCR de PDFs digitalizados (`scanned.pdf` continua a dar 0 resultados, com
uma mensagem clara de "este documento não tem texto pesquisável"), regex, pesquisa em vários
documentos ao mesmo tempo, guardar pesquisas. Ficam como entradas no `docs/BACKLOG.md`.

---

## 4. Verificação obrigatória antes de qualquer push

Os subagentes correm o subconjunto que lhes diz respeito antes de entregar. **O orquestrador
corre tudo na branch da fase, depois do merge**, e só faz push se tudo passar:

```
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm lint
pnpm typecheck
pnpm test
pnpm i18n:check
pnpm bindings:check
pnpm verify:pdf
pnpm build
pnpm tauri build --debug --no-bundle
pnpm e2e
```

- **App real**: compilar só com `pnpm tauri build --debug --no-bundle` (nunca usar o exe de um
  `cargo build` simples, porque espera o dev server). Abrir `book.pdf` com
  `src-tauri/target/debug/rubrica.exe <caminho absoluto>` e capturar com PrintWindow (flag 2,
  `SetProcessDPIAware()` primeiro, porque este PC está a 125 %). Capturas antes e depois vão no PR.
- **e2e**: no início de cada fase, guardar o resultado de `pnpm e2e` em `main`. Há specs
  interativas que já falham por uma limitação do harness tauri-driver/WebView2, não da app. O
  critério é **zero regressões face a essa baseline**, e as specs novas de pesquisa têm de
  passar ou ter a falha comprovadamente atribuída ao harness (com evidência no PR).
- Testes novos são obrigatórios para cada falha corrigida e cada funcionalidade nova. Nenhuma
  falha "corrigida" sem um teste que falhava antes.

Depois do push, a sessão orquestradora abre o PR com `gh pr create`, liga-o com as ferramentas
`ccd_pr` e lê o CI. Não ativa auto-merge.

---

## 5. Decisões tomadas

1. **Excluir cabeçalhos/rodapés** é uma **opção da pesquisa** (alternância no painel),
   **desligada por omissão**.
2. **Janela de proximidade** em **caracteres**, **500 por omissão**, configurável no painel
   (predefinições 100 / 250 / 500 / 1000 + valor livre entre 20 e 5000). A unidade "palavras"
   sai do âmbito: o contrato mantém só `window: u32` (caracteres), sem `unit`.
3. **Fase 2 num só PR**, com commits limpos por agente. Se o diff passar de ~3000 linhas,
   dividir.

## 6. Mockup da GUI (referência obrigatória)

[`docs/mockups/search-v2.html`](../docs/mockups/search-v2.html) define o layout, os textos (pt-PT),
as cores por termo, o mapa de densidade, o painel Índice e os estados (frase, proximidade,
seletor de âmbito aberto, sem índice, sem texto). S6 e S7 implementam-no fielmente com os tokens
existentes (`src/tokens`). Um desvio só é aceite quando é necessário, e tem de vir justificado
no relatório. O orquestrador inclui o caminho do mockup nos briefs de S2, S6 e S7 (S2 usa só a
parte da lista com contexto e o progresso).
