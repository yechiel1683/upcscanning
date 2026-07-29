# UPC Scanning

<sub>upcscanning.com · UPC Scanning LLC</sub>

**Upload a supplier product list. Download a folder of professional product images.**

Wholesalers, distributors, and deal sellers receive spreadsheets full of SKUs,
barcodes, and descriptions — and no photography. Someone then spends two days
searching for each product, saving images, cutting out backgrounds, and renaming
files. UPC Scanning does that whole job from one upload.

```
supplier_list.xlsx  ──►  identify ──► find real photo ──► render ──►  catalog_images.zip
                                   └► generate if none exists
```

---

## Start with nothing but barcodes

You do not need a filled-in spreadsheet. Paste a column of UPCs and the platform
works out the rest:

```
036000291452          ──►   Duracell_Coppertop_AA_Batteries_8_Pack_036000291452.jpg
885911574518                DeWalt_20V_MAX_Cordless_Drill_DCD771C2_885911574518.jpg
5449000000996               Coca_Cola_Classic_330ml_Can_5449000000996.jpg
```

Each barcode is resolved to a real product first — name, brand, model, category
— and only then do we look for its photograph. Those discovered details come
back with the images, in the export CSV and in the filenames.

**One API key covers the whole job.** With `OPENAI_API_KEY` set, the same key
identifies products, searches the web for real photography, and generates an
image when no real one exists. Nothing else is required.

## What it does

**Workflow A — find the real product image.** Every row is identified (brand,
model, category, what a wrong match would look like), then matched against
barcode databases, retailer listings, and manufacturer catalogs. Every candidate
is scored twice: *is this the right product* and *is this a usable photograph*.
Only a candidate that passes both is used.

**Workflow B — generate one.** Products with no findable photograph get a
studio-quality render built from their own description. These are labelled
`AI generated` everywhere they appear — in the dashboard, in the export CSV, in
the report, and optionally as a badge burned into the image itself.

**One consistent look.** Sourced and generated images go through the same
pipeline — cutout, framing, background, contact shadow, resize, encode — so a
catalog assembled from a dozen different websites looks like one photoshoot.

---

## The output

```
catalog_images.zip
├── Product Images/
│   ├── Samsung_55_Inch_Smart_TV_12345.jpg
│   ├── Apple_AirPods_Pro_2_67890.jpg
│   └── DeWalt_20V_Max_Drill_54321.jpg
├── products_with_images.csv     your rows + the details we discovered
│                                (name, brand, model, category, description)
│                                + filename, URL, provenance, scores
├── processing_report.txt        what was processed, and how
├── failed_products.csv          what did not work, and why
└── README.txt                   how to read the above
```

Filenames are `Brand_Product_Name_Identifier.ext`. The trailing identifier is
the SKU, or the barcode, or the spreadsheet row number — whichever exists — so
two similar products never collide, and every file maps back to a row.

---

## Interface

The product ships in **true black (#000000)** by default, with a one-click
light theme (**#ffffff**) in the header. The choice is remembered per browser
and applied by a blocking script before first paint, so a returning visitor
never sees the wrong theme flash.

Components never name a colour — they name a role (`canvas`, `surface`, `line`,
`fg`, `muted`, `accent`). Both themes fill those roles, which is why the whole
product flips by swapping CSS variables on `<html>` rather than by scattering
`dark:` variants through every file. A test asserts that every token is defined
in *both* themes, since one defined in only one is exactly how you end up with
white text on white in a single mode.

---

## Try it without a database

Setting up Postgres to answer "does this work on my products?" is a barrier
worth removing, so the app runs a guest mode with no account and no database:

```bash
npm install && npm run dev     # open /try
```

Paste barcodes or drop a spreadsheet and the real pipeline runs — same
identification, same search, same renderer, same ZIP. The differences are that
results live in memory for a few hours instead of Postgres, and a guest session
is capped (25 images, 25 products per batch) because unbounded in-memory state
on a public endpoint is a denial-of-service waiting to happen.

The deliverable is assembled by the same code either way, so a guest ZIP and an
account ZIP are byte-identical apart from a note in the report.

---

## Quick start

```bash
git clone https://github.com/yechiel1683/upcscanning.git
cd upcscanning
npm install
cp .env.example .env          # edit DATABASE_URL

docker compose up -d postgres # or point DATABASE_URL at your own
npx prisma migrate deploy
npm run seed                  # creates demo@upcscanning.com

npm run dev                   # http://localhost:3000
```

Sign in with the seeded account, then either upload
`examples/sample-products.csv` or go to **New upload → Barcode list** and paste
the codes from `examples/sample-barcodes.txt`.

### What you get for each level of setup

| Setup | Identification | Finding real photos | Fallback |
| --- | --- | --- | --- |
| No keys at all | Built-in rules | Keyless barcode databases only | Off |
| `OPENAI_API_KEY` | GPT | Barcode databases **+ web search** | Generation on |
| `+ SERPAPI_KEY` or Google CSE | GPT | Adds a dedicated image-search API | Generation on |

The middle row is the intended setup. The third is a cost/latency optimisation:
a dedicated image-search API is cheaper and faster per lookup than asking a
model to browse, and becomes worth adding at volume.

### With Redis and a dedicated worker

```bash
docker compose up -d postgres redis
QUEUE_DRIVER=redis npm run dev
QUEUE_DRIVER=redis npm run dev:worker   # in a second terminal
```

### Deploying to Railway

Railway builds the `Dockerfile` and reads `railway.json` for the healthcheck
and restart policy. Three things to set up:

1. **Add a Postgres service**, then set this service's `DATABASE_URL` to
   reference it (`${{Postgres.DATABASE_URL}}`). Migrations run automatically on
   every boot — see `scripts/release.ts` — so there is no manual release step.
   If the database is unreachable the container still starts, printing a banner
   in the logs: guest mode needs no database, and a site that boots and explains
   itself beats one that dies before it can.

2. **Set `OPENAI_API_KEY`** on *this* service, not on the Postgres service. That
   one key covers identification, web image search, and fallback generation.
   Railway redeploys on save; if it shows the change as staged, it is not live
   until you click **Deploy**.

3. **Give the images somewhere durable to live.** By default they are written
   to the container filesystem, which is wiped on every redeploy — so a catalog
   generated on Monday is gone after Tuesday's deploy. Either:
   - attach a Railway **volume** and set `STORAGE_LOCAL_DIR` to its mount path, or
   - set `STORAGE_DRIVER=s3` with the `S3_*` variables.

The app prints a preflight report at boot listing anything misconfigured,
including this one, so a broken deployment says so in the logs instead of
failing quietly at request time.

**If it still says the key is missing after you set it, open `/setup`.** Logs
are not much help here, because the four ways a key fails to arrive all look
identical from inside the process. That page separates them: it reports whether
the value reached the server at all, names any variable that looks like a
misspelling of one the app reads (`OPENAI_KEY`, a trailing space in the name),
flags a value that arrived wrapped in the quotes it was copied with, and — with
one button — asks OpenAI whether the key authenticates and whether the account
behind it has credit. API billing is separate from a ChatGPT subscription, and
an unfunded account fails in a way that looks exactly like a bad key. No value
is ever displayed, only whether it arrived.

For real throughput, add a Redis service, set `QUEUE_DRIVER=redis` and
`REDIS_URL`, and run a second Railway service from the same repo with the start
command `npm run worker`.

### Everything in Docker

```bash
docker compose up --build               # migrations run on start
docker compose up --scale worker=4      # more throughput
```

---

## Configuration

Every provider is optional and independently switchable. See `.env.example` for
the full annotated list.

| Capability | Variables | Without it |
| --- | --- | --- |
| Database | `DATABASE_URL` | Required |
| Queue | `QUEUE_DRIVER`, `REDIS_URL` | `inline` — jobs run in the web process |
| Storage | `STORAGE_DRIVER`, `S3_*` | `local` — files under `./storage` |
| Product understanding | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | Heuristic brand/model extraction |
| Barcode lookup | *(none needed)* | UPCitemdb trial + four Open Facts databases are keyless |
| Barcode lookup (higher limits) | `UPCITEMDB_API_KEY`, `GOUPC_API_KEY` | Trial rate limits |
| Web image search | `OPENAI_API_KEY` | Barcode sources only |
| Web image search (dedicated) | `SERPAPI_KEY` / `GOOGLE_CSE_*` / `BING_SEARCH_API_KEY` | Model browsing, which is slower per lookup |
| AI generation | `OPENAI_API_KEY` (or Replicate / Stability) | Workflow B disabled |
| Background removal | `BACKGROUND_REMOVAL_PROVIDER`, `REMOVEBG_API_KEY` | Built-in flood-fill cutout |
| Barcode cache | `LOOKUP_CACHE_ENABLED`, `LOOKUP_CACHE_TTL_DAYS` | On by default; disabling re-pays every repeat lookup |

The dashboard's Settings page shows exactly which providers are live, and the
overview explains *why* a capability is off rather than letting products fail
mysteriously.

---

## Architecture

```
src/
├── app/                         Next.js App Router — dashboard + API
│   ├── api/                     upload, batches, products, exports, images, auth
│   └── dashboard/               overview, upload wizard, batch detail, settings
├── server/
│   ├── lib/                     HTTP + SSRF guards, provider rate limiting
│   ├── ingest/                  CSV/XLSX parsing, barcode lists, column detection
│   ├── providers/
│   │   ├── llm/                 product understanding (OpenAI / Anthropic / heuristics)
│   │   ├── search/              barcode databases, OpenAI web search, image APIs
│   │   ├── generate/            OpenAI / Replicate / Stability
│   │   └── bgremove/            remove.bg, or the local cutout
│   ├── images/                  background segmentation, scoring, sharp pipeline, naming
│   ├── pipeline/                per-product orchestration and persistence
│   ├── export/                  ZIP + CSV + report builder
│   ├── queue/                   BullMQ and inline drivers
│   ├── storage/                 local disk and S3 drivers
│   └── auth/                    sessions and API keys
└── worker/                      BullMQ worker entry point
```

### How a product is processed

The order is barcode-first by design: `036000291452` is an unsearchable query,
while `Duracell Coppertop AA Batteries 8 Pack` is a very good one.

1. **Resolve the barcode.** Barcode databases are keyed on the exact GTIN, so
   they answer a different question from an image search: not *where is a
   picture* but *what is this thing*. Their answer fills in every product field
   the upload left blank, and feeds every step below.
2. **Identify.** The row becomes a canonical title, brand, model, search
   queries, a generation prompt, and — importantly — *negative keywords*: words
   that would mean a search result is an accessory rather than the product. A
   phone case is not a phone.
3. **Search.** Barcode-database images are tried first, then the open web, and
   the walk stops early once something is confidently good. Skipping the web
   tier on rows the barcode already answered is what keeps the unit cost of a
   1,000-product batch viable.
4. **Score before downloading.** Text signals (barcode present, model number
   match, title overlap, accessory keywords, URL shape, reported dimensions)
   filter candidates before any bandwidth is spent.
5. **Score after downloading.** Resolution, aspect ratio, backdrop uniformity,
   subject framing, and detail decide whether the photo is usable.
6. **Render.** Orient, segment, trim to the subject, resize into a padded frame,
   composite onto the backdrop, add a contact shadow, encode.
7. **Fall back.** No usable candidate and generation enabled → Workflow B.
8. **Persist.** The image, the discovered product details, its provenance, and
   the full candidate audit trail — including every rejection and its reason —
   are stored, so a wrong match is debuggable instead of mysterious.

A discovered detail never overwrites something the upload stated explicitly. It
only fills a blank, or replaces a placeholder we invented ourselves.

### Background removal

Catalog photography is overwhelmingly shot on a plain backdrop, so a
border-seeded flood fill handles the common case for free. It is deliberately
conservative: when the border is visually busy or the fill would consume most of
the frame, it reports low confidence and the pipeline **keeps the original
background** rather than punching a hole through the product. `remove.bg` is
available for the hard cases (soft edges, hair, glass, lifestyle shots).

### Scaling, quotas, and cost

Products are queued individually, so a 5,000-row upload is 5,000 independent
jobs. Throughput scales with `WORKER_CONCURRENCY` and with the number of worker
processes. The upload endpoint returns as soon as work is scheduled — it never
waits for images.

Two mechanisms keep that concurrency from working against you:

**A shared barcode cache.** A GTIN identifies the same product forever, and
supplier lists overlap heavily — the same barcode arrives again next month in
someone else's spreadsheet. Lookups are cached across every batch and user, so
the second time a barcode appears it costs nothing. This is what makes the
keyless tier (UPCitemdb's ~100/day trial) viable for bulk work, and it stops a
re-uploaded list re-spending your search budget. Misses are cached too, but
expire sooner, since a database may add the product later. Provider *outages*
are never cached — a transient 503 must not blind a barcode for three months.
Settings shows how many lookups the cache has saved.

**Per-provider rate limits.** Each provider declares a minimum spacing and a
concurrency ceiling, enforced centrally. The keyless trial tier is serialised;
OpenAI browsing is capped. Without this, eight workers would empty a
hundred-a-day allowance in seconds and then take 429s for the rest of the run.

One honest limitation: the rate limiter is per process, so running four worker
containers means four limiters and four times the configured rate. The cache is
what actually protects the tightest quota; a cross-process limiter would need
Redis, which is optional in this deployment.

---

## API

Authenticate with a session cookie or `Authorization: Bearer <api-key>`
(create keys in Settings).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/uploads/preview` | Parse a file and return the detected column mapping — no credits spent |
| `POST` | `/api/batches` | Create a batch from a spreadsheet (multipart: `file`, `mapping`, `options`) **or** a barcode list (JSON: `barcodes`, `options`) |
| `GET` | `/api/batches` | List batches |
| `GET` | `/api/batches/:id` | Live status and progress counters |
| `DELETE` | `/api/batches/:id` | Cancel if running, delete if finished |
| `GET` | `/api/batches/:id/products` | Paginated products, filterable by status |
| `POST` | `/api/batches/:id/retry` | Retry failed products |
| `POST` | `/api/batches/:id/export` | Build the ZIP |
| `GET` | `/api/exports/:id/download` | Stream the finished ZIP |
| `GET` | `/api/products/:id` | One product with its full candidate audit trail |
| `GET` | `/api/images/:id/file` | Serve a rendered image |
| `GET` | `/api/system/status` | Which providers are configured |
| `GET` | `/api/health` | Liveness probe |

```bash
# A spreadsheet
curl -X POST http://localhost:3000/api/batches \
  -H "Authorization: Bearer cf_live_…" \
  -F "file=@examples/sample-products.csv" \
  -F 'options={"width":1600,"height":1600,"background":"white","format":"jpeg"}'

# Just barcodes
curl -X POST http://localhost:3000/api/batches \
  -H "Authorization: Bearer cf_live_…" \
  -H "content-type: application/json" \
  -d '{"barcodes":"036000291452\n885911574518\n5449000000996"}'
```

---

## Development

```bash
npm run dev          # web app
npm run dev:worker   # worker (needs QUEUE_DRIVER=redis)
npm test             # vitest
npm run typecheck
npm run build
npm run release      # apply migrations + print the preflight report
npm run prisma:studio
```

The test suite runs the **real** sharp pipeline rather than mocking it — canvas
size, background colour, transparency, padding, and the cutout's refusal to
segment an unsegmentable photo are all asserted against actual pixels, because
those are the failures that matter and they are invisible to a mock.

---

## Notes on responsible use

Sourced images are matched from public product listings and retain their
provenance (`image_source` and `source_url` in the export CSV). Before
publishing images commercially, confirm you have the right to use them —
manufacturer and distributor agreements commonly grant this, but it is your
call to make, and the export gives you what you need to check.

AI-generated images are marked as such everywhere. They depict a plausible
version of the product, not the product itself. Review them before presenting
them as product photography.

---

## Roadmap

- Lifestyle and in-context shots
- Multiple angles per product
- Shopify and Amazon Seller Central push
- Supplier feed integrations (scheduled pulls)
- Browser extension for one-off products
