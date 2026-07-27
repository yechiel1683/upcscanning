# CatalogForge

**Upload a supplier product list. Download a folder of professional product images.**

Wholesalers, distributors, and deal sellers receive spreadsheets full of SKUs,
barcodes, and descriptions — and no photography. Someone then spends two days
searching for each product, saving images, cutting out backgrounds, and renaming
files. CatalogForge does that whole job from one upload.

```
supplier_list.xlsx  ──►  identify ──► find real photo ──► render ──►  catalog_images.zip
                                   └► generate if none exists
```

---

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
├── products_with_images.csv     your rows + filename, URL, provenance, scores
├── processing_report.txt        what was processed, and how
├── failed_products.csv          what did not work, and why
└── README.txt                   how to read the above
```

Filenames are `Brand_Product_Name_Identifier.ext`. The trailing identifier is
the SKU, or the barcode, or the spreadsheet row number — whichever exists — so
two similar products never collide, and every file maps back to a row.

---

## Quick start

```bash
git clone https://github.com/yechiel1683/upcscanning.git
cd upcscanning
npm install
cp .env.example .env          # edit DATABASE_URL and AUTH_SECRET

docker compose up -d postgres # or point DATABASE_URL at your own
npx prisma migrate deploy
npm run seed                  # creates demo@catalogforge.local

npm run dev                   # http://localhost:3000
```

Sign in with the seeded account and upload `examples/sample-products.csv`.

**It runs with zero third-party API keys.** No keys means no queue
infrastructure (jobs run in-process), heuristic product identification instead
of an LLM, and only the free barcode databases for image search. Add keys to
turn each capability on — nothing else changes.

### With Redis and a dedicated worker

```bash
docker compose up -d postgres redis
QUEUE_DRIVER=redis npm run dev
QUEUE_DRIVER=redis npm run dev:worker   # in a second terminal
```

### Everything in Docker

```bash
docker compose up --build
docker compose exec web npx prisma migrate deploy
docker compose up --scale worker=4      # more throughput
```

---

## Configuration

Every provider is optional and independently switchable. See `.env.example` for
the full annotated list.

| Capability | Variables | Without it |
| --- | --- | --- |
| Database | `DATABASE_URL` | Required |
| Sessions | `AUTH_SECRET` | Required |
| Queue | `QUEUE_DRIVER`, `REDIS_URL` | `inline` — jobs run in the web process |
| Storage | `STORAGE_DRIVER`, `S3_*` | `local` — files under `./storage` |
| Product understanding | `ANTHROPIC_API_KEY` | Heuristic brand/model extraction |
| Barcode lookup | *(none needed)* | UPCitemdb trial + Open Food Facts are keyless |
| Barcode lookup (higher limits) | `UPCITEMDB_API_KEY`, `GOUPC_API_KEY` | Trial rate limits |
| Web image search | `SERPAPI_KEY` / `GOOGLE_CSE_*` / `BING_SEARCH_API_KEY` | Barcode sources only |
| AI generation | `IMAGE_GENERATION_PROVIDER` + provider key | Workflow B disabled |
| Background removal | `BACKGROUND_REMOVAL_PROVIDER`, `REMOVEBG_API_KEY` | Built-in flood-fill cutout |

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
│   ├── ingest/                  CSV/XLSX parsing, column detection, normalisation
│   ├── providers/
│   │   ├── llm/                 product understanding (Anthropic + heuristics)
│   │   ├── search/              barcode databases and web image search
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

1. **Identify.** The row becomes a canonical title, brand, model, search
   queries, a generation prompt, and — importantly — *negative keywords*: words
   that would mean a search result is an accessory rather than the product. A
   phone case is not a phone.
2. **Search.** Providers are queried in trust order and the walk stops early. A
   barcode hit ends the search, which is what keeps the unit cost of a
   1,000-product batch viable.
3. **Score before downloading.** Text signals (barcode present, model number
   match, title overlap, accessory keywords, URL shape, reported dimensions)
   filter candidates before any bandwidth is spent.
4. **Score after downloading.** Resolution, aspect ratio, backdrop uniformity,
   subject framing, and detail decide whether the photo is usable.
5. **Render.** Orient, segment, trim to the subject, resize into a padded frame,
   composite onto the backdrop, add a contact shadow, encode.
6. **Fall back.** No usable candidate and generation enabled → Workflow B.
7. **Persist.** The image, its provenance, and the full candidate audit trail —
   including every rejection and its reason — are stored, so a wrong match is
   debuggable instead of mysterious.

### Background removal

Catalog photography is overwhelmingly shot on a plain backdrop, so a
border-seeded flood fill handles the common case for free. It is deliberately
conservative: when the border is visually busy or the fill would consume most of
the frame, it reports low confidence and the pipeline **keeps the original
background** rather than punching a hole through the product. `remove.bg` is
available for the hard cases (soft edges, hair, glass, lifestyle shots).

### Scaling

Products are queued individually, so a 5,000-row upload is 5,000 independent
jobs. Throughput scales with `WORKER_CONCURRENCY` and with the number of worker
processes. The upload endpoint returns as soon as work is scheduled — it never
waits for images.

---

## API

Authenticate with a session cookie or `Authorization: Bearer <api-key>`
(create keys in Settings).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/uploads/preview` | Parse a file and return the detected column mapping — no credits spent |
| `POST` | `/api/batches` | Create a batch and start processing (multipart: `file`, `mapping`, `options`) |
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
curl -X POST http://localhost:3000/api/batches \
  -H "Authorization: Bearer cf_live_…" \
  -F "file=@examples/sample-products.csv" \
  -F 'options={"width":1600,"height":1600,"background":"white","format":"jpeg"}'
```

---

## Development

```bash
npm run dev          # web app
npm run dev:worker   # worker (needs QUEUE_DRIVER=redis)
npm test             # vitest
npm run typecheck
npm run build
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
