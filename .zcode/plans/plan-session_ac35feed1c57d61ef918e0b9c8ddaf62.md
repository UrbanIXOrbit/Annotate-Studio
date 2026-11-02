# Port the reference-lookup2.html engine into the app

The HTML file is a complete browser adaptation of the therightbibtex method, and per your direction it becomes the citation engine. It replaces my lookup core (single-source fallbacks, priority merge) with its full pipeline: identifier detection with ISBN checksum validation → nine sources queried in parallel per input kind → union-find clustering with title-similarity/author/year thresholds → preprint-vs-published version separation → weighted per-field merge (source weights + per-field bonuses, author consensus, year voting) → confidence scoring → expand phase that follows discovered DOIs/arXiv/PMIDs.

## 1. New engine — `src/lib/reference-lookup.ts`

Port from the HTML, typed and node-testable:
- **Detection**: `detect()` (DOI / arXiv / PMID / ISBN with `validIsbn` checksum / title), `isbn13` (incl. ISBN-10→13 conversion), `parseName` with name particles.
- **Record model + 9 source adapters** (Crossref, OpenAlex, DataCite, Europe PMC, PubMed, Semantic Scholar, arXiv, Open Library, Google Books) with `WEIGHTS` + `FIELD_BONUS`, mapping straight from the file. DOM-free string cleaning; the arXiv XML adapter uses `DOMParser` at call time (webview) only.
- **Network**: the engine owns `fetchJson` (moves from book-citations.ts) — 404 → `NotFoundError`, 429 → the friendly `CatalogueHttpError`, desktop-fetch fallback preserved; per-source `enabled` flags; a settable contact email for the Crossref/OpenAlex/PubMed polite pools (replaces the unused constant).
- **Clustering/versions/merge/scoring**: `normTitle/lev/tokenSim/titleSimilarity/titleContain/authorsOverlap/sameWork/titlesAgree/dropForeignIds/cluster`, `buildVersions`, `mergeVersion` (prov, conflicts, confidence, evidence groups), `recordMatch/clusterScore/rankClusters`, and the two-phase `lookupLine(raw, opts)` with the 16s/10s budgets and dedup.

## 2. Richer citation record — `src/store/books.ts` + `citation-schema.ts`

`BookCitation` gains optional fields the merge produces: `type` (book/article/chapter/conference/preprint/thesis/other), `container` (journal/venue), `volume`, `issue`, `pages`, `editors[]`, `url`, `note`, `confidence`. `CITATION_SOURCE_NAMES` extends with the new sources (openalex, datacite, europepmc, pubmed, semanticscholar, arxiv); `fieldSources` is populated from the engine's provenance map; `conflicts` keeps field names. `migrateBookCitation` validates the new fields. Old saved citations keep working — everything is optional.

## 3. Formatters ported — `src/lib/citation-formats.ts`

Replace the book-only formatters with the file's APA 7 / Harvard / MLA 9 / Chicago author-date / **Vancouver (new style)** — output as plain text (our previews/copy are text) but with the full structure: articles with journal/volume/issue/pages, chapters with editors, edition ordinals, DOI URLs. Port its `toBibtex` (type mapping incl. `inproceedings`/`incollection`, editors, `booktitle`, `pages--`, citation-key dedup) and `toRis` (ED lines, JO/T2, VL/IS/SP/EP). `toCslJson` extended with the new fields. Existing exports/signatures unchanged; the style tests are rewritten to the new expected output.

## 4. Rewired lookup — `src/lib/book-citations.ts`

- `enrichCitation(seed)`: ISBN → isbn-kind lookup, DOI → doi-kind, else title-kind query (`cleanSearchTitle(seed.title)` + first-author surname) → `lookupLine` → top merged record + candidates (other versions / next-best clusters), auto-apply exactly when the file's rule fires (single match, or title score ≥0.95 with a ≥0.04 gap) → mapped to `BookCitation` with provenance/confidence.
- `lookupByIsbn(isbn)` → engine isbn-kind (invalid checksum → null, so "Generate" falls back to the seed).
- **Removed**: `lookupEverywhere`, `aggregateRecords`, the three old mappers, `pickIsbn`, `searchBooks`, `SOURCE_LABELS`/priority machinery (superseded — the clustering handles what they approximated).
- **Kept**: `extractCitationFromFile`, `cleanSearchTitle`, `parseCitationInput` (now also recognizing DOIs hidden in your filenames — `10.1515_9783111611358-005` → `10.1515/9783111611358-005`, which is most of your library), `isCitationCapable`, `fallbackTitleFromFile`.

## 5. UI — same flows, richer results

- `CitationCandidateList`: rows gain the confidence pill ("Cross-checked / Partly / Not cross-checked"), the contributing-sources line, a retracted warning, and conflict chips (existing).
- `AddCitationDialog`: "Optional settings" section with per-source enable checkboxes and the contact-email field (both persisted in localStorage, like the file); results show warnings (missing authors/year, disagreements with values).
- `BookCitationSection` edit form gains Journal/venue, Volume, Issue, Pages fields.
- Flows (pick → save → displayName adoption → batch export) are untouched.

## 6. Tests + verification

- New `reference-lookup.test.ts`: detect/isbn13/parseName, similarity + sameWork boundaries, clustering by shared DOI, version building, weighted merge + conflicts + confidence, partial-title matching.
- `book-citations.test.ts`: drop tests of removed functions, keep the rest; `citation-formats.test.ts` rewritten for the ported formatters; driver gains passthrough checks for the new fields.
- `tsc --noEmit` → full `npm test` → store driver → esbuild bundle → `npm run app`.

**Honest notes**: Semantic Scholar rate-limits without a key (it's disable-able per source, like the file); citation output text will change to the file's style (that's the point); the engines' expand phase adds a second wave of requests for ambiguous lookups, bounded by the same budgets as the file.