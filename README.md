# Wikipedia search on Elasticsearch

A real search application over a Wikipedia dump, built to understand what Lucene
does underneath. The Node app is a *client*: it parses, cleans and queries.
Elasticsearch does the analysis, the inverted index, BM25, segments and merging.

**Current state** — 20,865 articles indexed, 557 MB, 5 segments, single node,
single shard, Elasticsearch 9.5.0 on Lucene 10.5.0.

A full walkthrough of what happens internally at each step lives in
[`docs/elasticsearch-internals.html`](docs/elasticsearch-internals.html).

---

## Quick start

```bash
docker compose up -d                 # Elasticsearch on :9200
npm install
npm run typecheck

# XML dump -> cleaned JSONL -> index, in one command (~3.5 min)
npm run ingest -- ~/Downloads/enwiki-latest-pages-articles1.xml-p1p41242

npm run serve                        # search API on :3000
curl 'http://127.0.0.1:3000/search?q=anarchism'
```

Already have `data/wikipedia.jsonl`? Skip the dump entirely:

```bash
npm run reindex -- --index wikipedia_v2
```

---

## Commands

### The two you will actually use

| Command | Reads | Writes | Time |
|---|---|---|---|
| `npm run ingest -- <dump.xml>` | XML dump | `data/wikipedia.jsonl` **and** an index | ~3.5 min |
| `npm run reindex -- --index NAME` | `data/wikipedia.jsonl` | a new index + moves the alias | ~25 s |

**`ingest`** runs all four stages: collect redirects, clean wikitext to JSONL,
create the index, bulk load. The JSONL is cached — a second run **reuses** it and
skips straight to loading. Pass `--rebuild` to force a fresh one.

```bash
npm run ingest -- <dump.xml>                     # reuse JSONL if present
npm run ingest -- <dump.xml> --rebuild           # re-parse the XML
npm run ingest -- <dump.xml> --limit 200         # fast end-to-end smoke test
npm run ingest -- <dump.xml> --index wikipedia_v3
```

**`reindex`** is the one to use after any mapping or analyzer change. It never
touches the XML, creates the named index with the *current* mapping, loads it,
and moves the `wikipedia` alias atomically. The API queries the alias, so a
running server picks up the new index without a restart. The old index is left
in place for comparison — delete it yourself when done.

```bash
npm run reindex -- --index wikipedia_v3
curl -X DELETE localhost:9200/wikipedia_v2       # once you have compared them
```

### Everything else

| Command | What it does |
|---|---|
| `npm run serve` | Search API on `:3000`. `--port 8080`, `--log` for request logging. |
| `npm run relevance` | Scores search quality against `relevance/judgments.json`. |
| `npm run judge -- "query"` | Prints real candidate titles to put in the judgment set. |
| `npm run corpus -- <dump.xml>` | Stage 1–2 only: XML → JSONL, no Elasticsearch. |
| `npm run inspect -- <dump.xml>` | Parser sanity check. Prints sample pages and corpus totals. No Elasticsearch. |
| `npm run typecheck` | `tsc --noEmit`. Run before anything else. |
| `npm run compile` | `tsc` → `dist/`. Not needed for development; `tsx` runs the TypeScript directly. |

Note the `--` in every example. npm needs it to pass arguments through to the
script rather than consuming them itself.

### Relevance workflow

```bash
npm run relevance                          # score the weighted query
npm run relevance -- --strategy simple     # unweighted single-field baseline
npm run relevance -- --strategy fuzzy
```

Reports P@k, R@k, MRR and nDCG@10 per query. **Read the deltas, not the
absolutes** — change one boost in `QueryBuilder.WEIGHTED_FIELDS`, rerun, compare.

`relevance/judgments.json` ships as a *seed with guessed titles*. Any judged
title missing from the index is listed in a `MISSING` column rather than
silently scoring zero. Replace those with real ones:

```bash
npm run judge -- "plate tectonics"
```

---

## HTTP API

`npm run serve`, then `GET /` lists everything.

| Endpoint | Query it runs |
|---|---|
| `/health` · `/stats` | cluster info, document count, index size, segments |
| `/search?q=&from=&size=&highlight=&after=` | weighted `multi_match`, `best_fields` |
| `/search/simple?q=&field=text` | single-field `match` — the baseline |
| `/search/phrase?q=&field=text` | `match_phrase`, order and adjacency matter |
| `/search/fuzzy?q=` | `fuzziness: AUTO`, `prefix_length: 1` |
| `/search/prefix?q=&field=title` | `match_phrase_prefix`, expanded at query time |
| `/search/bool?must=&should=&not=&category=` | repeat any parameter to add clauses |
| `/suggest?q=` | autocomplete via the FST completion suggester |
| `/docs/:id` | one document by `wiki_id` |
| `/explain/:id?q=` | BM25 breakdown — idf, tf, boost, field length |

```bash
curl 'http://127.0.0.1:3000/search?q=anarchism&highlight=1&size=5'
curl 'http://127.0.0.1:3000/search/bool?must=philosophy&not=fiction'
curl 'http://127.0.0.1:3000/suggest?q=anar'
curl 'http://127.0.0.1:3000/explain/12?q=anarchism'
```

Several endpoints exist as **deliberate comparisons**: `/search` against
`/search/simple` shows what field boosting buys, and `/search/prefix` against
`/suggest` shows query-time term expansion against a prebuilt FST. Compare their
`took` values.

Pagination past a few pages should use the cursor, not `from`:

```bash
curl 'http://127.0.0.1:3000/search?q=history&size=10'
# take next_cursor from the response
curl 'http://127.0.0.1:3000/search?q=history&size=10&after=<next_cursor>'
```

---

## Layout

```
ingestion/     XML → documents
  WikiXmlParser      streaming SAX parser, constant memory
  RedirectIndex      inverted redirect graph (pass 1)
  WikiCleaner        wikitext → prose + categories, headings, links
  CorpusBuilder      two passes → data/wikipedia.jsonl
  JsonlCorpus        reads the corpus back as an async iterable
  DocumentTransform  fields derived at index time (autocomplete inputs)
  BulkIndexer        bulk API, refresh_interval handling
  IngestPipeline     the four stages, in order

es/
  SearchCluster      owns the client
  WikipediaIndex     settings, mapping, alias swap, stats

search/
  QueryBuilder       every query shape, in one place
  SearchService      execution, paging, highlighting, response mapping
  BM25Explainer      Lucene's explanation tree → per-term idf/tf/boost

relevance/           judgment set + precision/recall/MRR/nDCG harness
api/ApiServer        Fastify routes
cli/                 entry points, one per npm script
types.ts             WikiPage (from the dump) vs WikiDocument (into ES)
```

The pipeline, end to end:

```
enwiki.xml ──parse──> WikiPage ──clean──> WikiDocument ──> wikipedia.jsonl
                                                                  │
                                              +title_suggest ─────┤
                                                                  ▼
                                                        POST /_bulk → Lucene
```

`data/wikipedia.jsonl` is the pivot. Everything upstream of it is expensive and
runs once; everything downstream is cheap and runs whenever the mapping changes.
That is why mapping experiments cost 25 seconds instead of 3.5 minutes.

---

## Troubleshooting

**`npm run reindex` hangs at "creating …"** — almost always disk. Elasticsearch
refuses to allocate a shard below its disk watermark and the create request
blocks waiting for one. Check:

```bash
curl -s 'localhost:9200/_cluster/health?pretty' | grep -E 'status|unassigned'
df -h /
curl -s 'localhost:9200/_cluster/allocation/explain?pretty'
```

This cluster runs with **absolute** watermarks rather than the percentage
defaults, because percentages leave no usable headroom on a large disk:

```bash
curl -X PUT localhost:9200/_cluster/settings -H 'Content-Type: application/json' -d '{
  "persistent": {
    "cluster.routing.allocation.disk.watermark.low": "6gb",
    "cluster.routing.allocation.disk.watermark.high": "4gb",
    "cluster.routing.allocation.disk.watermark.flood_stage": "2gb"
  }
}'
```

Elasticsearch re-checks disk usage roughly every 30 seconds and assigns shards on
its own once space is freed — no restart needed.

**`/suggest` returns nothing** — the index predates the `title_suggest` field.
Mappings are fixed at write time, so run `npm run reindex`.

**Elasticsearch won't start** — needs `sudo sysctl -w vm.max_map_count=262144`.

---

## Roadmap status

| Phase | Items | State |
|---|---|---|
| 1 · Ingestion, mapping, search, BM25 | 1–4 | done |
| 2 · bool, fuzzy, autocomplete, highlighting, pagination, relevance harness | 5–9 | done |
| 3 · Analyzers, stemming, synonyms | 10–15 | next |
| 4 · Wikipedia-specific search | 16–20 | |
| 5 · Aggregations, sorting, aliases, lifecycle | 21–24 | |
| 6 · Lucene internals, then distributed | 25–38 | |

Phase 3 is where the alias and JSONL machinery earns out: define a new analyzer,
`npm run reindex --index wikipedia_v3`, and score it against Phase 2 with
`npm run relevance`.
