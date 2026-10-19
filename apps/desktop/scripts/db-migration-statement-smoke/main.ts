/**
 * True isolated migration fault matrix. Instrument the sql.js Statement's
 * underlying free(), never a mock-only implementation of migrate().
 * Data is a synthetic legacy DB in the runner's temporary data root.
 */
import initSqlJs from "sql.js/dist/sql-asm.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { initDb, getDb, closeDb } from "@main/store/db.js";
import { DEFAULT_LIBRARY_GROUPS, LIBRARY_GROUPS_SETTING_KEY } from "@contracts/libraryTypes";

let total=0, failed=0;
function check(label:string,good:boolean,detail?:unknown) {
 total++; if(good)console.log("  ok   "+label);
 else {failed++;console.log("  FAIL "+label+" "+JSON.stringify(detail));}
}
const SQL=await initSqlJs();
const root=process.env.MCODE_SMOKE_DATA_ROOT;
if(!root)throw new Error("MISSING ISOLATED DATA ROOT");
const dbFile=join(root,"mcode.db");
// Genuine legacy schema, old saved classifications, and an unrelated
// user-owned legacy table that upgrades may not silently discard.
const legacy=new SQL.Database();
legacy.run([
 "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
 "CREATE TABLE library_collections(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'paper',prompt TEXT,parent_id TEXT,sort_order INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);",
 "INSERT INTO library_collections(id,name,kind,created_at) VALUES('legacy_collection','Historical classification','paper',100);",
 "CREATE TABLE institution_profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL);",
 "INSERT INTO institution_profiles VALUES('owned_entrance','User-owned portal');",
].join("\n"));
legacy.run("INSERT INTO settings(key,value) VALUES(?,?)", [
 LIBRARY_GROUPS_SETTING_KEY, JSON.stringify(DEFAULT_LIBRARY_GROUPS),
]);
const originalBytes=legacy.export();
legacy.close();
const basePrototype=SQL.Database.prototype as unknown as { prepare: (sql:string)=>unknown };
const actualPrepare=basePrototype.prepare;
type Step="bind"|"step"|"row";
const tests:Array<{label:string,match:string,stages:Step[]}>=[
 {label:"count outstanding group backfill",match:"SELECT COUNT(*) AS n FROM library_collections",stages:["step","row"]},
 {label:"load group settings",match:"SELECT value FROM settings WHERE key = ?",stages:["bind","step","row"]},
 {label:"load legacy classification rows",match:"SELECT id, kind FROM library_collections",stages:["bind","step","row"]},
 {label:"check retired table presence",match:"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",stages:["bind","step"]},
 {label:"inspect old column",match:"SELECT name FROM pragma_table_info(?) WHERE name = ?",stages:["bind","step"]},
];
for(const {label,match,stages} of tests) {
 for(const stage of stages) {
  writeFileSync(dbFile,Buffer.from(originalBytes));
  let prepared=0,freed=0;
  const fault=new Error("MIGRATION_FAULT_"+label+"_"+stage);
  basePrototype.prepare=function(sql:string) {
   const stmt=actualPrepare.call(this,sql) as {
    bind:(values:unknown[])=>unknown;step:()=>boolean;
    getAsObject:()=>unknown;free:()=>unknown
   };
   if(!sql.includes(match))return stmt;
   prepared++;
   return {
    bind:(values:unknown[])=>{if(stage==="bind")throw fault;return stmt.bind(values);},
    step:()=>{if(stage==="step")throw fault;return stmt.step();},
    getAsObject:()=>{if(stage==="row")throw fault;return stmt.getAsObject();},
    free:()=>{freed++;return stmt.free();},
   };
  };
  let error:unknown=null;
  try{await initDb()}catch(err){error=err}
  finally{basePrototype.prepare=actualPrepare}
  check(label+"/"+stage+": migration failure surfaces unchanged",error===fault,{received:String(error),prepared});
  check("★★ "+label+"/"+stage+": original prepared statement freed",
    prepared===1&&freed===1,{prepared,freed});
  // The failed provisional handle must not be published. A retry must
  // reload the *same* old file, rather than a half-migrated in-memory copy.
  let blocked=false;
  try{getDb()}catch{blocked=true}
  check(label+"/"+stage+": failed migration has no published DB handle",blocked);
  try{
   await initDb();
   const db=getDb();
   const col=db.exec("SELECT name,group_id FROM library_collections WHERE id='legacy_collection'")[0]?.values[0];
   check(label+"/"+stage+": reinitialized upgrade retained old classification",col?.[0]==="Historical classification");
   const portals=db.exec("SELECT name FROM institution_profiles WHERE id='owned_entrance'")[0]?.values[0];
   check(label+"/"+stage+": old user portal untouched",portals?.[0]==="User-owned portal");
  }catch(err) {
   check(label+"/"+stage+": after-fault retry can initialize",false,String(err));
  }finally{
   try{closeDb()}catch(err){check(label+"/"+stage+": closing isolated retry DB",false,String(err));}
  }
 }
}
console.log("db-migration-statement-smoke:"+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
