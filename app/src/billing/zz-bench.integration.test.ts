import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { sql } from "kysely";
import { it } from "vitest";
import { createPostgresTestDatabase } from "../test-support/postgres-test-database.ts";
const out = (s: string) => appendFileSync("/tmp/pg591/out.txt", s + "\n");
it("bench", async () => {
  const { db } = await createPostgresTestDatabase();
  await sql`set session_replication_role = replica`.execute(db).catch(() => undefined);
  const trx = db;
  // pool: set on every connection is not guaranteed; use a transaction
  await db.transaction().execute(async (t) => {
    await sql`set local session_replication_role = replica`.execute(t);
    await sql`insert into workspaces (id,name,slug,created_at) select 'w'||g,'w'||g,'w'||g,'2026-01-01T00:00:00.000Z' from generate_series(1,100) g`.execute(t);
    await sql`insert into repositories (id,workspace_id,integration_id,external_id,full_name,url,active,created_at,updated_at) select 'r'||g,'w'||g,'i','e'||g,'o/r'||g,'u',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' from generate_series(1,100) g`.execute(t);
    // 100k jobs, 1000 per workspace; ended 'succeeded'
    await sql`insert into jobs (id,workspace_id,repository_id,pr_number,pr_url,head_sha,command,args,trigger_kind,actor_login,status,run_after,attempts,created_at,updated_at)
      select 'j'||g,'w'||(1+g%100),'r'||(1+g%100),g,'u','sha','review','',  'webhook','a','succeeded','2026-01-01T00:00:00.000Z',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' from generate_series(1,100000) g`.execute(t);
    await sql`insert into usage_records (id,workspace_id,job_id,review_kind,key_mode,state,reserved_at,settled_at)
      select 'u'||g,'w'||(1+g%100),'j'||g,'diff','own','settled','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' from generate_series(1,100000) g`.execute(t);
    await sql`insert into billing_journal_entries (id,workspace_id,type,amount_micro_usd,ref_key,job_id,created_at)
      select 'er'||g,'w'||(1+g%100),'reservation',-325000,'j'||g,'j'||g,'2026-01-01T00:00:00.000Z' from generate_series(1,100000) g`.execute(t);
    await sql`insert into billing_journal_entries (id,workspace_id,type,amount_micro_usd,ref_key,job_id,created_at)
      select 'el'||g,'w'||(1+g%100),'release',325000,'j'||g,'j'||g,'2026-01-01T00:00:00.000Z' from generate_series(1,100000) g`.execute(t);
    // 20 running jobs with open holds + 3 stranded (ended, settled record, no release)
    await sql`update jobs set status='running' where id in (select 'j'||g from generate_series(1,20) g)`.execute(t);
    await sql`update usage_records set state='reserved', settled_at=null where job_id in (select 'j'||g from generate_series(1,20) g)`.execute(t);
    await sql`delete from billing_journal_entries where type='release' and ref_key in (select 'j'||g from generate_series(1,23) g)`.execute(t);
    await sql`insert into billing_balances (workspace_id,balance_micro_usd,reserved_micro_usd,updated_at)
      select 'w'||g, 0, coalesce((select sum(-amount_micro_usd) from billing_journal_entries r where r.workspace_id='w'||g and type='reservation' and not exists (select 1 from billing_journal_entries l where l.workspace_id=r.workspace_id and l.type='release' and l.ref_key=r.ref_key)),0),'2026-01-01T00:00:00.000Z' from generate_series(1,100) g`.execute(t);
  });
  if (process.env.EXTRA_WS) await db.transaction().execute(async (t) => {
    await sql`set local session_replication_role = replica`.execute(t);
    await sql`insert into workspaces (id,name,slug,created_at) select 'x'||g,'x'||g,'x'||g,'2026-01-01T00:00:00.000Z' from generate_series(1,${sql.lit(Number(process.env.EXTRA_WS))}) g`.execute(t);
    await sql`insert into billing_balances (workspace_id,balance_micro_usd,reserved_micro_usd,updated_at) select 'x'||g,1000,0,'2026-01-01T00:00:00.000Z' from generate_series(1,${sql.lit(Number(process.env.EXTRA_WS))}) g`.execute(t);
  });
  if (process.env.IDX) await sql.raw(process.env.IDX).execute(db);
  await sql`analyze`.execute(db);
  for (const f of readdirSync("/tmp/pg591/q").sort()) {
    const text = readFileSync("/tmp/pg591/q/" + f, "utf8");
    out("=== " + f);
    for (const stmt of text.split(";;")) {
      if (stmt.trim() === "") continue;
      const { rows } = await sql.raw(`explain (analyze, buffers, costs off, timing off) ${stmt}`).execute(db);
      out(rows.map((r) => (r as Record<string, string>)["QUERY PLAN"]).join("\n"));
    }
  }
}, 600000);
