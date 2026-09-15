# Railway setup

The exact click path to bring up the account half of the product. Everything
here needs an account in your name, which is why it is a list rather than code.

Do them in order — each step assumes the one before it.

---

## 1. Postgres

Without this there are no accounts, no batches, no credits. The guest trial
works without it; nothing else does.

1. In the project, **New → Database → Add PostgreSQL**.
2. Open the **upcscanning** service → **Variables**.
3. Add: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`

   Type it exactly, with the braces. Railway resolves it to the private
   network address, which is faster and not exposed to the internet.

Migrations apply automatically on the next boot — `npm run start` runs
`prisma migrate deploy` first. They have been verified to apply cleanly from an
empty database, so this should need no intervention.

**Check it worked:** `https://upcscanning.com/api/health/ready` should report
`"database": { "ok": true }`.

---

## 2. Redis and the worker

Without these, jobs run inside the web process. That works, but a deploy or a
restart loses every batch that was mid-flight, and image processing competes
with serving pages for the same CPU.

1. **New → Database → Add Redis**.
2. On the **upcscanning** service → **Variables**, add:
   - `REDIS_URL` = `${{Redis.REDIS_URL}}`
   - `QUEUE_DRIVER` = `redis`
3. **New → GitHub Repo → yechiel1683/upcscanning** to add a *second* service
   from the same repository. Name it **worker**.
4. On the worker service → **Settings**:
   - **Config-as-code** path: `railway.worker.json`

     That file sets the start command to `npm run worker` and turns off the
     healthcheck, because the worker serves no HTTP and would otherwise be
     killed for not answering.
   - **Branch connected**: `main`
5. On the worker service → **Variables**, add the same variables as the web
   service. The worker runs the identical pipeline and needs the same access:
   `DATABASE_URL`, `REDIS_URL`, `QUEUE_DRIVER`, `OPENAI_API_KEY`, `APP_URL`,
   and the storage variables from step 3.

**Check it worked:** `/api/health/ready` reports
`"queue": { "ok": true, "configured": true }`. The worker's deploy logs should
say it is listening on both queues.

**Scaling:** raise `WORKER_CONCURRENCY` (default 3) or add replicas to the
worker service. Memory is the binding constraint — image rendering is
off-heap, so a container will be killed before Node reports pressure. Start at
concurrency 3 and watch the Metrics tab.

---

## 3. Storage

Rendered images currently go to the container's own disk, which is wiped on
every deploy. Customers would find their images gone after an unrelated update.

Pick **one** of these.

### Option A — Railway volume (simpler)

1. Web service → **Settings → Volumes → New Volume**, mount path `/data/storage`.
2. Variables: `STORAGE_LOCAL_DIR` = `/data/storage`
3. The worker writes images too, so it needs the same volume mounted at the
   same path.

Fine for one worker. A volume attaches to one service at a time, so this does
not survive scaling the worker past a single replica.

### Option B — S3 (scales, costs a little)

Any S3-compatible bucket: AWS, Cloudflare R2, Backblaze B2.

Variables on **both** services:

```
STORAGE_DRIVER=s3
S3_BUCKET=<bucket name>
S3_REGION=<region>
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
S3_ENDPOINT=<only for R2 or B2; leave unset for AWS>
```

**Check it worked:** `https://upcscanning.com/api/health/ready?deep=1` — this
one writes a real test object, reads it back and deletes it. Credentials that
authenticate but cannot write look identical to working ones until the first
customer clicks an image, so run the deep check rather than assuming.

---

## 4. Backups

Once there is real customer data, a backup you have never restored is a hope.

`npm run backup` takes a dump *and* restores it into a scratch database to
prove it is real, then drops the scratch. It exits non-zero when the dump does
not restore, so a scheduled run will actually notice.

Run it against the public database URL — Railway's `DATABASE_PUBLIC_URL`, not
the private one, since a scheduled job outside the project cannot see the
private network.

---

## Variable reference

Needed on both the web and worker services:

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Accounts, batches, credits |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | The job queue |
| `QUEUE_DRIVER` | `redis` | Use the queue rather than the web process |
| `OPENAI_API_KEY` | your key | Identify, search, verify, generate |
| `APP_URL` | `https://upcscanning.com` | Image links in the export CSV |
| `TRUSTED_PROXY_HOPS` | `1` | How rate limits identify a caller |
| `GUEST_DAILY_IMAGE_LIMIT` | `2000` | Ceiling on free-trial spend; `0` closes it |

Storage variables from step 3 go on both services too.
