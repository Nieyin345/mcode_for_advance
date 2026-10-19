import { ThinkTagSplitter, type ThinkSegment } from "@main/lib/thinkTagSplitter.js";
let checks=0,failed=0;
const check=(name:string, condition:boolean, actual?:unknown)=>{
  checks++;
  console.log((condition?"ok ":"FAIL ")+name+(condition?"":" "+JSON.stringify(actual)));
  if(!condition)failed++;
};
const flatten=(parts:ThinkSegment[]):string=>parts.map(x=>x.kind+":"+x.text).join("|");
{
  const s=new ThinkTagSplitter();
  const text="<not-a-tag>".repeat(4_000);
  const out=s.push(text);
  check("★ thousands of non-tag angle brackets do not allocate thousands of output segments",out.length===1,{length:out.length});
  check("many non-tag brackets still reproduce original text",out.map(x=>x.text).join("")===text);
  check("non-tag bracket sequence stays plain text",out.every(x=>x.kind==="text"));
  check("flush of complete plain text is empty",s.flush().length===0);
}
{
  const s=new ThinkTagSplitter();
  const data=["Hello <th","ink>secret","</thi","nk> tail"];
  const result=data.flatMap(d=>s.push(d)).concat(s.flush());
  check("split tag boundaries classify thinking correctly",
    flatten(result)==="text:Hello |thinking:secret|text: tail",flatten(result));
}
{
  const s=new ThinkTagSplitter();
  const result=s.push("a<<think>hidden</think>b").concat(s.flush());
  check("literal bracket before tag remains visible", result.filter(x=>x.kind==="text").map(x=>x.text).join("")==="a<b");
  check("real internal content still thinking", result.filter(x=>x.kind==="thinking").map(x=>x.text).join("")==="hidden");
}
{
  const s=new ThinkTagSplitter();
  const result=s.push("keep<thi").concat(s.flush());
  check("unterminated partial tag at EOF is not dropped",result.map(x=>x.text).join("")==="keep<thi");
}
console.log("think-tag-chunk-integrity-smoke:"+ (checks-failed)+"/"+checks+" PASS");
if(failed)process.exitCode=1;
